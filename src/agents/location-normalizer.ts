import { logger } from '../utils/logger.js';
import { callLLM } from '../llm/client.js';
import {
  LocationParseResultSchema,
  LocationParseJsonSchema,
  type LocationParseResult,
  type NormalizedLocation,
} from '../schemas/llm-outputs.js';
import type { IAgent } from '../core/interfaces.js';

export interface LocationNormalizerInput {
  text: string;
  clarification?: string; // User's answer to a previous clarification question
}

export interface LocationNormalizerOutput {
  locations: NormalizedLocation[];
  needsClarification?: {
    question: string;
    options: string[];
  };
}

/**
 * LocationNormalizerAgent - uses LLM to parse and normalize location input
 *
 * Features:
 * - Parses any natural language location input
 * - Normalizes to structured format with search variants
 * - Asks clarifying questions when input is ambiguous
 * - Handles "Remote" as a special location type
 */
export class LocationNormalizerAgent implements IAgent<LocationNormalizerInput, LocationNormalizerOutput> {
  async execute(input: LocationNormalizerInput): Promise<LocationNormalizerOutput> {
    const { text, clarification } = input;

    logger.info('LocationNormalizer', `Parsing location: "${text}"${clarification ? ` (with clarification: "${clarification}")` : ''}`);

    const systemPrompt = `You are a location parsing expert for a job search application. Your task is to parse user-provided location text into a structured format.

You MUST respond with a valid JSON object containing:
- locations: array of normalized location objects
- needsClarification: (optional) object with question and options if input is ambiguous

Each location object must have:
- raw: the original text fragment this location came from
- display: formatted display name (e.g., "New York, NY, USA" or "Remote")
- city: city name if applicable (optional)
- state: state/province/region if applicable (optional)
- country: country name (use full name for display, but "USA" is acceptable for United States)
- searchVariants: array of alternative names to use when searching job boards (include abbreviations, full names, common variations)
- type: either "physical" or "remote"

RULES:
1. Parse multiple locations from comma-separated, "and", or "or" delimited input
2. IMPORTANT: "Remote" ALWAYS requires a country. There is NO worldwide/global remote option.
   - "Remote" or "remote only" without country context → set needsClarification asking which country
   - "Remote in [country]", "Remote [country]", "[country] remote" → type: "remote" with country set to that country
   - Example: "Remote in Canada" → type: "remote", country: "Canada", display: "Canada (Remote)"
3. When user says "X or Remote", you MUST ask for clarification about which country for the remote jobs
4. Include useful searchVariants for job board compatibility:
   - "NYC" → searchVariants: ["New York", "NYC", "New York City", "Manhattan"]
   - "SF" → searchVariants: ["San Francisco", "SF", "Bay Area"]
   - "USA" → searchVariants: ["United States", "USA", "US"]
5. For ambiguous locations (like "Springfield" which exists in 30+ US states), set needsClarification with:
   - question: a clear question asking for clarification
   - options: array of 3-5 most likely options (most populous first)
   - Still return an empty locations array when clarification is needed
6. For country-wide searches, omit city/state and use country name for searchVariants
7. REJECT "anywhere", "worldwide", "skip", "any", "global" - set needsClarification asking for a specific country or region
8. If input seems like a real location but you're not 100% sure it exists, parse it anyway - job boards will handle invalid locations gracefully
9. NEVER use country: "Worldwide" - always require a specific country for remote jobs

EXAMPLES:

Input: "NYC, Boston, and remote"
Output:
{
  "locations": [],
  "needsClarification": {
    "question": "Which country should I search for remote jobs?",
    "options": ["USA (Remote)", "Canada (Remote)", "UK (Remote)", "Germany (Remote)", "Other country"]
  }
}

Input: "Springfield" (ambiguous)
Output:
{
  "locations": [],
  "needsClarification": {
    "question": "Which Springfield do you mean?",
    "options": ["Springfield, IL, USA", "Springfield, MA, USA", "Springfield, MO, USA", "Springfield, OH, USA", "All of them"]
  }
}

Input: "Remote SF"
Output:
{
  "locations": [],
  "needsClarification": {
    "question": "What do you mean by 'Remote SF'?",
    "options": ["USA remote jobs + On-site jobs in SF", "Only remote jobs from SF-based companies", "On-site SF jobs only"]
  }
}

Input: "anywhere"
Output:
{
  "locations": [],
  "needsClarification": {
    "question": "Please specify a country or region. We don't support worldwide searches.",
    "options": ["USA", "Canada", "UK", "Europe", "Other (please specify)"]
  }
}

Input: "remote"
Output:
{
  "locations": [],
  "needsClarification": {
    "question": "Which country should I search for remote jobs?",
    "options": ["USA (Remote)", "Canada (Remote)", "UK (Remote)", "Europe (Remote)", "Other country"]
  }
}

Input: "Remote in Canada"
Output:
{
  "locations": [
    { "raw": "Remote in Canada", "display": "Canada (Remote)", "country": "Canada", "searchVariants": ["Canada", "CA"], "type": "remote" }
  ]
}

Input: "USA remote"
Output:
{
  "locations": [
    { "raw": "USA remote", "display": "USA (Remote)", "country": "USA", "searchVariants": ["United States", "USA", "US"], "type": "remote" }
  ]
}

Input: "Canada or remote"
Output:
{
  "locations": [],
  "needsClarification": {
    "question": "Which country should I search for remote jobs? (You also mentioned Canada for on-site)",
    "options": ["Canada (Remote) + Canada (On-site)", "USA (Remote) + Canada (On-site)", "Canada (On-site only, no remote)"]
  }
}

Input: "Remote, Canada Toronto preferable, but USA remote is okay"
Output:
{
  "locations": [
    { "raw": "Toronto", "display": "Toronto, ON, Canada", "city": "Toronto", "state": "Ontario", "country": "Canada", "searchVariants": ["Toronto", "Toronto ON"], "type": "physical" },
    { "raw": "USA remote", "display": "USA (Remote)", "country": "USA", "searchVariants": ["United States", "USA", "US"], "type": "remote" }
  ]
}`;

    let userPrompt = `Parse this location input: "${text}"`;

    if (clarification) {
      userPrompt += `\n\nThe user was asked to clarify and responded with: "${clarification}"\n\nUse this clarification to provide a definitive answer without asking for more clarification.`;
    }

    try {
      const result = await callLLM<LocationParseResult>(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        LocationParseResultSchema,
        LocationParseJsonSchema
      );

      logger.info('LocationNormalizer', `Parsed ${result.locations.length} locations${result.needsClarification ? ' (needs clarification)' : ''}`);

      return result;
    } catch (error) {
      logger.error('LocationNormalizer', 'Location parsing failed', error);
      throw error;
    }
  }

  /**
   * Deduplicate locations - keep only one "Remote" entry and unique physical locations
   */
  static deduplicate(locations: NormalizedLocation[]): NormalizedLocation[] {
    const result: NormalizedLocation[] = [];
    let hasRemote = false;
    const seenDisplays = new Set<string>();

    for (const loc of locations) {
      if (loc.type === 'remote') {
        if (!hasRemote) {
          result.push(loc);
          hasRemote = true;
        }
      } else {
        const key = loc.display.toLowerCase();
        if (!seenDisplays.has(key)) {
          seenDisplays.add(key);
          result.push(loc);
        }
      }
    }

    return result;
  }

  /**
   * Format locations for display in Telegram messages
   */
  static formatForDisplay(locations: NormalizedLocation[]): string {
    if (locations.length === 0) {
      return 'No location specified';
    }

    const remoteLocations = locations.filter(l => l.type === 'remote');
    const physicalLocations = locations.filter(l => l.type === 'physical');

    const parts: string[] = [];

    for (const loc of physicalLocations) {
      parts.push(loc.display);
    }

    // Show remote locations with their display name (e.g., "Canada (Remote)")
    for (const loc of remoteLocations) {
      parts.push(loc.display);
    }

    return parts.join('\n');
  }

  /**
   * Format locations for single-line display (e.g., in subscription list)
   */
  static formatForDisplaySingleLine(locations: NormalizedLocation[]): string {
    if (locations.length === 0) {
      return 'No location specified';
    }

    const remoteLocations = locations.filter(l => l.type === 'remote');
    const physicalLocations = locations.filter(l => l.type === 'physical');

    const parts: string[] = [];

    for (const loc of physicalLocations) {
      parts.push(loc.display);
    }

    // Show remote locations with their display name (e.g., "Canada (Remote)")
    for (const loc of remoteLocations) {
      parts.push(loc.display);
    }

    if (parts.length <= 2) {
      return parts.join(' + ');
    }

    return `${parts.slice(0, 2).join(', ')} +${parts.length - 2} more`;
  }

  /**
   * Check if any location is worldwide remote (not country-specific)
   * @deprecated Worldwide remote is no longer supported - all remote locations require a country
   */
  static hasWorldwideRemote(locations: NormalizedLocation[]): boolean {
    return locations.some(l => l.type === 'remote' && l.country === 'Worldwide');
  }

  /**
   * Check if any location is remote (country-specific only)
   */
  static hasRemote(locations: NormalizedLocation[]): boolean {
    return locations.some(l => l.type === 'remote');
  }

  /**
   * Get remote locations (all remote locations require a country now)
   */
  static getCountrySpecificRemote(locations: NormalizedLocation[]): NormalizedLocation[] {
    return locations.filter(l => l.type === 'remote');
  }

  /**
   * Get physical locations only
   */
  static getPhysicalLocations(locations: NormalizedLocation[]): NormalizedLocation[] {
    return locations.filter(l => l.type === 'physical');
  }

  /**
   * Check if a job matches the normalized locations
   */
  static matchesJob(locations: NormalizedLocation[], job: { location?: string; isRemote?: boolean }): boolean {
    // No location filter means no jobs match (worldwide not supported)
    if (locations.length === 0) {
      return false;
    }

    const jobLocationLower = (job.location || '').toLowerCase();

    // Check remote locations (all require a country now)
    const remoteLocations = LocationNormalizerAgent.getCountrySpecificRemote(locations);
    if (job.isRemote && remoteLocations.length > 0) {
      // Job must be remote AND in one of the specified countries
      for (const loc of remoteLocations) {
        for (const variant of loc.searchVariants) {
          if (jobLocationLower.includes(variant.toLowerCase())) {
            return true;
          }
        }
        // Also check country name directly
        if (jobLocationLower.includes(loc.country.toLowerCase())) {
          return true;
        }
      }
    }

    // Check physical locations
    const physicalLocations = LocationNormalizerAgent.getPhysicalLocations(locations);

    if (!jobLocationLower) {
      // Job has no location, only match if we have remote in our list
      return LocationNormalizerAgent.hasRemote(locations);
    }

    // Check if job location matches any of our physical locations' search variants
    for (const loc of physicalLocations) {
      for (const variant of loc.searchVariants) {
        if (jobLocationLower.includes(variant.toLowerCase())) {
          return true;
        }
      }
      // Also check the display name
      if (jobLocationLower.includes(loc.display.toLowerCase())) {
        return true;
      }
      // And the city/state if present
      if (loc.city && jobLocationLower.includes(loc.city.toLowerCase())) {
        return true;
      }
      if (loc.state && jobLocationLower.includes(loc.state.toLowerCase())) {
        return true;
      }
    }

    return false;
  }
}
