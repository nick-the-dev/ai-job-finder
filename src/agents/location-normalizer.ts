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
2. "Remote", "remote only", "work from home", "WFH" (with no country context) → type: "remote" with display: "Remote" and country: "Worldwide"
3. "Remote in [country]", "Remote [country]", "[country] remote" → type: "remote" with country set to that country (NOT "Worldwide")
   - This means the user wants remote jobs from/in that specific country
   - Example: "Remote in Canada" → type: "remote", country: "Canada", display: "Canada (Remote)"
4. When user says "X or Remote", parse as TWO separate locations (one physical, one remote)
5. Include useful searchVariants for job board compatibility:
   - "NYC" → searchVariants: ["New York", "NYC", "New York City", "Manhattan"]
   - "SF" → searchVariants: ["San Francisco", "SF", "Bay Area"]
   - "USA" → searchVariants: ["United States", "USA", "US"]
6. For ambiguous locations (like "Springfield" which exists in 30+ US states), set needsClarification with:
   - question: a clear question asking for clarification
   - options: array of 3-5 most likely options (most populous first)
   - Still return an empty locations array when clarification is needed
7. For country-wide searches, omit city/state and use country name for searchVariants
8. For "anywhere", "worldwide", "skip", "any" → return empty locations array (no location filter)
9. If input seems like a real location but you're not 100% sure it exists, parse it anyway - job boards will handle invalid locations gracefully
10. IMPORTANT: If input mentions BOTH generic "remote" AND country-specific remote (e.g., "Remote... USA remote"), ask for clarification:
   - User might want: global remote + on-site locations
   - Or: ONLY country-specific remote + on-site (no global remote)
   - Or: All three options (global remote + country-specific remote + on-site)

EXAMPLES:

Input: "NYC, Boston, and remote"
Output:
{
  "locations": [
    { "raw": "NYC", "display": "New York, NY, USA", "city": "New York", "state": "New York", "country": "USA", "searchVariants": ["New York", "NYC", "New York City"], "type": "physical" },
    { "raw": "Boston", "display": "Boston, MA, USA", "city": "Boston", "state": "Massachusetts", "country": "USA", "searchVariants": ["Boston", "Boston MA"], "type": "physical" },
    { "raw": "remote", "display": "Remote", "country": "Worldwide", "searchVariants": [], "type": "remote" }
  ]
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
    "options": ["Remote jobs anywhere + On-site jobs in SF", "Only remote jobs from SF-based companies", "Remote jobs anywhere (ignore SF)"]
  }
}

Input: "anywhere"
Output:
{
  "locations": []
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
  "locations": [
    { "raw": "Canada", "display": "Canada", "country": "Canada", "searchVariants": ["Canada", "CA"], "type": "physical" },
    { "raw": "remote", "display": "Remote", "country": "Worldwide", "searchVariants": [], "type": "remote" }
  ]
}

Input: "Remote, Canada Toronto preferable, but USA remote is okay"
Output:
{
  "locations": [],
  "needsClarification": {
    "question": "You mentioned both 'Remote' and 'USA remote'. What do you mean?",
    "options": [
      "Remote anywhere + Toronto on-site",
      "Toronto on-site + USA-based remote only (no global remote)",
      "All: Remote anywhere + Toronto on-site + USA-based remote"
    ]
  }
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
      return 'Anywhere';
    }

    const worldwideRemote = locations.filter(l => l.type === 'remote' && l.country === 'Worldwide');
    const countrySpecificRemote = locations.filter(l => l.type === 'remote' && l.country !== 'Worldwide');
    const physicalLocations = locations.filter(l => l.type === 'physical');

    const parts: string[] = [];

    for (const loc of physicalLocations) {
      parts.push(loc.display);
    }

    // Show country-specific remote with the display name (e.g., "Canada (Remote)")
    for (const loc of countrySpecificRemote) {
      parts.push(loc.display);
    }

    // Show worldwide remote as just "Remote"
    if (worldwideRemote.length > 0) {
      parts.push('Remote');
    }

    return parts.join('\n');
  }

  /**
   * Format locations for single-line display (e.g., in subscription list)
   */
  static formatForDisplaySingleLine(locations: NormalizedLocation[]): string {
    if (locations.length === 0) {
      return 'Anywhere';
    }

    const worldwideRemote = locations.filter(l => l.type === 'remote' && l.country === 'Worldwide');
    const countrySpecificRemote = locations.filter(l => l.type === 'remote' && l.country !== 'Worldwide');
    const physicalLocations = locations.filter(l => l.type === 'physical');

    const parts: string[] = [];

    for (const loc of physicalLocations) {
      parts.push(loc.display);
    }

    // Show country-specific remote with the display name (e.g., "Canada (Remote)")
    for (const loc of countrySpecificRemote) {
      parts.push(loc.display);
    }

    // Show worldwide remote as just "Remote"
    if (worldwideRemote.length > 0) {
      parts.push('Remote');
    }

    if (parts.length <= 2) {
      return parts.join(' + ');
    }

    return `${parts.slice(0, 2).join(', ')} +${parts.length - 2} more`;
  }

  /**
   * Check if any location is worldwide remote (not country-specific)
   */
  static hasWorldwideRemote(locations: NormalizedLocation[]): boolean {
    return locations.some(l => l.type === 'remote' && l.country === 'Worldwide');
  }

  /**
   * Check if any location is remote (worldwide or country-specific)
   */
  static hasRemote(locations: NormalizedLocation[]): boolean {
    return locations.some(l => l.type === 'remote');
  }

  /**
   * Get country-specific remote locations (e.g., "Remote in Canada")
   * These need to be searched WITH the country + isRemote: true
   */
  static getCountrySpecificRemote(locations: NormalizedLocation[]): NormalizedLocation[] {
    return locations.filter(l => l.type === 'remote' && l.country !== 'Worldwide');
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
    // No location filter means all jobs match
    if (locations.length === 0) {
      return true;
    }

    const jobLocationLower = (job.location || '').toLowerCase();

    // Worldwide remote jobs match any remote in our list
    if (job.isRemote && LocationNormalizerAgent.hasWorldwideRemote(locations)) {
      return true;
    }

    // Check country-specific remote (e.g., "Remote in Canada")
    const countrySpecificRemote = LocationNormalizerAgent.getCountrySpecificRemote(locations);
    if (job.isRemote && countrySpecificRemote.length > 0) {
      // Job must be remote AND in one of the specified countries
      for (const loc of countrySpecificRemote) {
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
    if (physicalLocations.length === 0 && countrySpecificRemote.length === 0) {
      // Only worldwide remote in list, no match for non-remote job
      return job.isRemote === true;
    }

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
