import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';
import type { NormalizedJob } from '../core/types.js';

/**
 * Update skill statistics for a subscription
 * Called after each matching run to track matched/missing skills
 */
export async function updateSkillStats(
  subscriptionId: string,
  matchedSkills: string[],
  missingSkills: string[]
): Promise<void> {
  const db = getDb();

  // Aggregate skill counts
  const matchedCounts = new Map<string, number>();
  const missingCounts = new Map<string, number>();

  for (const skill of matchedSkills) {
    const normalized = skill.toLowerCase().trim();
    if (normalized) {
      matchedCounts.set(normalized, (matchedCounts.get(normalized) || 0) + 1);
    }
  }

  for (const skill of missingSkills) {
    const normalized = skill.toLowerCase().trim();
    if (normalized) {
      missingCounts.set(normalized, (missingCounts.get(normalized) || 0) + 1);
    }
  }

  // Upsert skill stats
  const allSkills = new Set([...matchedCounts.keys(), ...missingCounts.keys()]);

  for (const skill of allSkills) {
    const matchedInc = matchedCounts.get(skill) || 0;
    const missingInc = missingCounts.get(skill) || 0;

    await db.skillStats.upsert({
      where: {
        subscriptionId_skill: { subscriptionId, skill },
      },
      create: {
        subscriptionId,
        skill,
        matchedCount: matchedInc,
        missingCount: missingInc,
        demandCount: matchedInc + missingInc,
      },
      update: {
        matchedCount: { increment: matchedInc },
        missingCount: { increment: missingInc },
        demandCount: { increment: matchedInc + missingInc },
      },
    });
  }

  logger.debug('Analytics', `Updated skill stats for ${allSkills.size} skills`);
}

/**
 * Create a market snapshot from collected jobs
 * Called periodically to track market trends
 */
export async function createMarketSnapshot(
  jobTitles: string[],
  location: string | null,
  isRemote: boolean,
  jobs: NormalizedJob[]
): Promise<void> {
  const db = getDb();

  if (jobs.length === 0) return;

  // Calculate aggregates
  const salaries = jobs.filter(j => j.salaryMin || j.salaryMax);
  const avgSalaryMin = salaries.length > 0
    ? Math.round(salaries.reduce((sum, j) => sum + (j.salaryMin || 0), 0) / salaries.length)
    : null;
  const avgSalaryMax = salaries.length > 0
    ? Math.round(salaries.reduce((sum, j) => sum + (j.salaryMax || 0), 0) / salaries.length)
    : null;

  const remoteCount = jobs.filter(j => j.isRemote).length;

  // Top companies
  const companyCounts = new Map<string, number>();
  for (const job of jobs) {
    const company = job.company.trim();
    if (company) {
      companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    }
  }
  const topCompanies = [...companyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([company, count]) => ({ company, count }));

  // Top locations
  const locationCounts = new Map<string, number>();
  for (const job of jobs) {
    const loc = job.location?.trim();
    if (loc) {
      locationCounts.set(loc, (locationCounts.get(loc) || 0) + 1);
    }
  }
  const topLocations = [...locationCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([location, count]) => ({ location, count }));

  // Top skills (from job descriptions - simple extraction)
  const skillKeywords = [
    'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c++', 'c#',
    'react', 'vue', 'angular', 'node.js', 'django', 'flask', 'spring',
    'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform',
    'sql', 'postgresql', 'mysql', 'mongodb', 'redis',
    'graphql', 'rest', 'api', 'microservices',
    'machine learning', 'ai', 'data science', 'blockchain',
  ];
  const skillCounts = new Map<string, number>();
  for (const job of jobs) {
    const descLower = job.description.toLowerCase();
    for (const skill of skillKeywords) {
      if (descLower.includes(skill)) {
        skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
      }
    }
  }
  const topSkills = [...skillCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([skill, count]) => ({ skill, count }));

  await db.marketSnapshot.create({
    data: {
      jobTitles,
      location,
      isRemote,
      totalJobs: jobs.length,
      avgSalaryMin,
      avgSalaryMax,
      remoteCount,
      topCompanies,
      topSkills,
      topLocations,
    },
  });

  logger.debug('Analytics', `Created market snapshot: ${jobs.length} jobs`);
}

/**
 * Get personal stats for a subscription (for /stats command)
 */
export async function getPersonalStats(subscriptionId: string) {
  const db = getDb();

  // Get subscription with user
  const subscription = await db.searchSubscription.findUnique({
    where: { id: subscriptionId },
    include: {
      user: { select: { firstName: true, username: true } },
      sentNotifications: { select: { sentAt: true } },
    },
  });

  if (!subscription) return null;

  // Get run stats (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const runs = await db.subscriptionRun.findMany({
    where: {
      subscriptionId,
      startedAt: { gte: sevenDaysAgo },
      status: 'completed',
    },
    select: {
      jobsCollected: true,
      jobsMatched: true,
      notificationsSent: true,
      startedAt: true,
    },
  });

  // Get match score distribution
  const matches = await db.jobMatch.findMany({
    where: { resumeHash: subscription.resumeHash },
    select: { score: true, createdAt: true },
  });

  const recentMatches = matches.filter(m => m.createdAt >= sevenDaysAgo);

  const scoreDistribution = {
    excellent: recentMatches.filter(m => m.score >= 90).length,
    strong: recentMatches.filter(m => m.score >= 70 && m.score < 90).length,
    moderate: recentMatches.filter(m => m.score >= 50 && m.score < 70).length,
    weak: recentMatches.filter(m => m.score < 50).length,
  };

  // Get top matched/missing skills
  const skillStats = await db.skillStats.findMany({
    where: { subscriptionId },
    orderBy: [{ matchedCount: 'desc' }],
  });

  const topMatchedSkills = skillStats
    .filter(s => s.matchedCount > 0)
    .slice(0, 5)
    .map(s => s.skill);

  const topMissingSkills = skillStats
    .filter(s => s.missingCount > 0)
    .sort((a, b) => b.missingCount - a.missingCount)
    .slice(0, 5)
    .map(s => s.skill);

  // Calculate aggregates
  const totalJobsScanned = runs.reduce((sum, r) => sum + r.jobsCollected, 0);
  const totalMatches = runs.reduce((sum, r) => sum + r.jobsMatched, 0);
  const matchRate = totalJobsScanned > 0 ? (totalMatches / totalJobsScanned) * 100 : 0;
  const avgScore = recentMatches.length > 0
    ? recentMatches.reduce((sum, m) => sum + m.score, 0) / recentMatches.length
    : 0;

  // Activity by day
  const dailyStats = new Map<string, { jobs: number; matches: number }>();
  for (const run of runs) {
    const day = run.startedAt.toISOString().split('T')[0];
    const current = dailyStats.get(day) || { jobs: 0, matches: 0 };
    dailyStats.set(day, {
      jobs: current.jobs + run.jobsCollected,
      matches: current.matches + run.jobsMatched,
    });
  }

  return {
    subscription: {
      jobTitles: subscription.jobTitles,
      location: subscription.location,
      minScore: subscription.minScore,
      createdAt: subscription.createdAt,
    },
    summary: {
      totalJobsScanned,
      totalMatches,
      matchRate: Math.round(matchRate * 10) / 10,
      avgScore: Math.round(avgScore),
      notificationsSent: subscription.sentNotifications.length,
    },
    scoreDistribution,
    skills: {
      topMatched: topMatchedSkills,
      topMissing: topMissingSkills,
    },
    activity: [...dailyStats.entries()].map(([date, stats]) => ({ date, ...stats })),
  };
}

/**
 * Get market insights for a subscription (for /market command)
 */
export async function getMarketInsights(subscriptionId: string) {
  const db = getDb();

  const subscription = await db.searchSubscription.findUnique({
    where: { id: subscriptionId },
    select: { jobTitles: true, location: true, isRemote: true },
  });

  if (!subscription) return null;

  // Get recent market snapshots matching this subscription's criteria
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const snapshots = await db.marketSnapshot.findMany({
    where: {
      date: { gte: thirtyDaysAgo },
      // Match any of the job titles
      OR: subscription.jobTitles.map(title => ({
        jobTitles: { has: title },
      })),
    },
    orderBy: { date: 'desc' },
    take: 10,
  });

  if (snapshots.length === 0) {
    // Fallback: get any recent jobs from DB
    const recentJobs = await db.job.findMany({
      where: { firstSeenAt: { gte: thirtyDaysAgo } },
      take: 500,
      select: {
        salaryMin: true,
        salaryMax: true,
        company: true,
        location: true,
        isRemote: true,
      },
    });

    if (recentJobs.length === 0) return null;

    // Calculate on the fly
    const salaries = recentJobs.filter(j => j.salaryMin || j.salaryMax);
    const avgSalaryMin = salaries.length > 0
      ? Math.round(salaries.reduce((sum, j) => sum + (j.salaryMin || 0), 0) / salaries.length)
      : null;
    const avgSalaryMax = salaries.length > 0
      ? Math.round(salaries.reduce((sum, j) => sum + (j.salaryMax || 0), 0) / salaries.length)
      : null;

    const companyCounts = new Map<string, number>();
    for (const job of recentJobs) {
      companyCounts.set(job.company, (companyCounts.get(job.company) || 0) + 1);
    }

    return {
      salary: { min: avgSalaryMin, max: avgSalaryMax },
      topCompanies: [...companyCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([company, count]) => ({ company, count })),
      remoteRatio: Math.round((recentJobs.filter(j => j.isRemote).length / recentJobs.length) * 100),
      totalJobs: recentJobs.length,
      dataSource: 'live',
    };
  }

  // Aggregate from snapshots
  const latestSnapshot = snapshots[0];
  const topCompanies = (latestSnapshot.topCompanies as Array<{ company: string; count: number }>).slice(0, 5);
  const topSkills = (latestSnapshot.topSkills as Array<{ skill: string; count: number }>).slice(0, 10);
  const topLocations = (latestSnapshot.topLocations as Array<{ location: string; count: number }>).slice(0, 5);

  return {
    salary: {
      min: latestSnapshot.avgSalaryMin,
      max: latestSnapshot.avgSalaryMax,
    },
    topCompanies,
    topSkills,
    topLocations,
    remoteRatio: Math.round((latestSnapshot.remoteCount / latestSnapshot.totalJobs) * 100),
    totalJobs: latestSnapshot.totalJobs,
    dataSource: 'snapshot',
    snapshotDate: latestSnapshot.date,
  };
}

/**
 * Get resume improvement tips (for /tips command)
 */
export async function getResumeTips(subscriptionId: string) {
  const db = getDb();

  const subscription = await db.searchSubscription.findUnique({
    where: { id: subscriptionId },
    select: { resumeHash: true, minScore: true },
  });

  if (!subscription) return null;

  // Get skill stats
  const skillStats = await db.skillStats.findMany({
    where: { subscriptionId },
    orderBy: { demandCount: 'desc' },
  });

  // Find skills that are frequently missing but in high demand
  const skillGaps = skillStats
    .filter(s => s.missingCount > 0 && s.demandCount >= 3)
    .sort((a, b) => {
      // Sort by missing ratio (missing / demand)
      const aRatio = a.missingCount / a.demandCount;
      const bRatio = b.missingCount / b.demandCount;
      return bRatio - aRatio;
    })
    .slice(0, 5);

  // Get user's match scores to calculate average
  const matches = await db.jobMatch.findMany({
    where: { resumeHash: subscription.resumeHash },
    select: { score: true },
  });

  const avgScore = matches.length > 0
    ? Math.round(matches.reduce((sum, m) => sum + m.score, 0) / matches.length)
    : 0;

  // Get platform-wide average for comparison
  const allMatches = await db.jobMatch.aggregate({
    _avg: { score: true },
  });

  const platformAvgScore = Math.round(allMatches._avg.score || 0);

  // Generate tips
  const tips: Array<{ type: string; message: string; priority: 'high' | 'medium' | 'low' }> = [];

  // Skill gap tips
  for (const gap of skillGaps) {
    const missingPercent = Math.round((gap.missingCount / gap.demandCount) * 100);
    tips.push({
      type: 'skill_gap',
      message: `${missingPercent}% of jobs require "${gap.skill}" but it's not matching in your resume`,
      priority: missingPercent > 70 ? 'high' : missingPercent > 40 ? 'medium' : 'low',
    });
  }

  // Score comparison tip
  if (avgScore < platformAvgScore - 5) {
    tips.push({
      type: 'score_comparison',
      message: `Your average match score (${avgScore}) is below the platform average (${platformAvgScore}). Consider updating your resume with more relevant keywords.`,
      priority: 'medium',
    });
  } else if (avgScore > platformAvgScore + 10) {
    tips.push({
      type: 'score_comparison',
      message: `Great work! Your average score (${avgScore}) is above the platform average (${platformAvgScore}).`,
      priority: 'low',
    });
  }

  // Top matched skills (positive reinforcement)
  const topMatched = skillStats
    .filter(s => s.matchedCount > 0)
    .sort((a, b) => b.matchedCount - a.matchedCount)
    .slice(0, 3)
    .map(s => s.skill);

  return {
    avgScore,
    platformAvgScore,
    matchCount: matches.length,
    skillGaps: skillGaps.map(s => ({
      skill: s.skill,
      missingCount: s.missingCount,
      demandCount: s.demandCount,
      missingPercent: Math.round((s.missingCount / s.demandCount) * 100),
    })),
    topMatched,
    tips,
  };
}
