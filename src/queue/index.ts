// Queue system exports
export { initRedis, disconnectRedis, isRedisConnected } from './redis.js';
export { initQueues, closeQueues, getQueues, getQueueStatus, PRIORITY } from './queues.js';
export { queueService, QueueService } from './service.js';
export { startCollectionWorker } from './workers/collection.js';
export { startMatchingWorker } from './workers/matching.js';

// Types
export type { CollectionJobData, MatchingJobData, Priority } from './queues.js';
