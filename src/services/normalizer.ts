import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import type { RawJob, NormalizedJob } from '../core/types.js';
import type { IService } from '../core/interfaces.js';

/**
 * NormalizerService - standardizes job data and generates content hash for dedup
 */
export class NormalizerService implements IService<RawJob[], NormalizedJob[]> {
  async execute(jobs: RawJob[]): Promise<NormalizedJob[]> {
    logger.info('Normalizer', `Processing ${jobs.length} jobs...`);

    const normalized = jobs.map((job) => this.normalizeJob(job));

    // Deduplicate by content hash
    const seen = new Set<string>();
    const unique = normalized.filter((job) => {
      if (seen.has(job.contentHash)) {
        return false;
      }
      seen.add(job.contentHash);
      return true;
    });

    const dupeCount = normalized.length - unique.length;
    if (dupeCount > 0) {
      logger.info('Normalizer', `Removed ${dupeCount} duplicates`);
    }

    logger.info('Normalizer', `Returning ${unique.length} unique jobs`);
    return unique;
  }

  private normalizeJob(job: RawJob): NormalizedJob {
    // Clean and normalize text
    const title = this.cleanText(job.title);
    const company = this.cleanText(job.company);
    const description = this.cleanText(job.description);
    const location = job.location ? this.cleanText(job.location) : undefined;

    // Generate content hash for deduplication
    // Based on title + company + first 500 chars of description
    const contentHash = this.generateHash(title, company, description.substring(0, 500));

    return {
      ...job,
      title,
      company,
      description,
      location,
      contentHash,
    };
  }

  private cleanText(text: string): string {
    return text
      .trim()
      .replace(/\s+/g, ' ')           // Normalize whitespace
      .replace(/[\u200B-\u200D\uFEFF]/g, ''); // Remove zero-width chars
  }

  private generateHash(title: string, company: string, descriptionPrefix: string): string {
    const content = `${title.toLowerCase()}|${company.toLowerCase()}|${descriptionPrefix.toLowerCase()}`;
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }
}
