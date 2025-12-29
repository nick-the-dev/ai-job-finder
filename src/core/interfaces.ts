/**
 * Core interfaces - DRY foundation for services and agents
 */

/**
 * Base interface for all services (no LLM - deterministic)
 */
export interface IService<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}

/**
 * Base interface for AI agents (uses LLM - requires verification)
 */
export interface IAgent<TInput, TOutput> extends IService<TInput, TOutput> {
  /**
   * Verify LLM output against source data to prevent hallucinations
   */
  verify?(output: TOutput, source: unknown): Promise<VerifiedOutput<TOutput>>;
}

/**
 * Wrapper for verified LLM outputs
 */
export interface VerifiedOutput<T> {
  data: T;
  verified: boolean;
  warnings: string[];
}
