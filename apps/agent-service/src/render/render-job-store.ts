import { randomUUID } from 'node:crypto';
import type { CandidateObservation, RenderJob, RenderJobLease } from '@ui-agent/contracts';

type JobRecord = RenderJob & {
  leaseToken?: string;
  leaseExpiresAt?: number;
  completedLeaseToken?: string;
  observation?: CandidateObservation;
  failure?: string;
};

/**
 * Short-lived delivery queue for browser rendering. Rendered evidence is
 * persisted by the workspace store; jobs intentionally expire on restart so a
 * late browser response can never be treated as current evidence.
 */
export class RenderJobStore {
  private readonly jobs = new Map<string, JobRecord>();

  create(input: Omit<RenderJob, 'jobId' | 'status' | 'createdAt' | 'deadlineAt'> & { deadlineMs: number }): RenderJob {
    const now = Date.now();
    const job: JobRecord = {
      ...input,
      jobId: randomUUID(),
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + input.deadlineMs).toISOString()
    };
    this.jobs.set(job.jobId, job);
    return this.publicJob(job);
  }

  claim(workspaceId: string, candidateId?: string, candidateVersion?: number, now = Date.now(), leaseMs = 15_000): RenderJobLease | undefined {
    this.expire(now);
    const job = [...this.jobs.values()].find(item => (
      item.workspaceId === workspaceId
      && item.status === 'pending'
      && (candidateId === undefined || item.candidateId === candidateId)
      && (candidateVersion === undefined || item.candidateVersion === candidateVersion)
    ));
    if (!job) return undefined;
    const deadline = Date.parse(job.deadlineAt);
    const expiresAt = Math.min(deadline, now + leaseMs);
    if (expiresAt <= now) {
      job.status = 'failed';
      job.failure = 'RENDER_TIMEOUT';
      return undefined;
    }
    job.status = 'leased';
    job.leaseToken = randomUUID();
    job.leaseExpiresAt = expiresAt;
    return { ...this.publicJob(job), leaseToken: job.leaseToken, leaseExpiresAt: new Date(expiresAt).toISOString() };
  }

  validateLease(workspaceId: string, jobId: string, leaseToken: string, now = Date.now()): RenderJob | undefined {
    this.expire(now);
    const job = this.jobs.get(jobId);
    if (!job || job.workspaceId !== workspaceId || job.status !== 'leased' || job.leaseToken !== leaseToken) return undefined;
    if ((job.leaseExpiresAt ?? 0) <= now) return undefined;
    return this.publicJob(job);
  }

  complete(workspaceId: string, jobId: string, leaseToken: string, observation: CandidateObservation, now = Date.now()): CandidateObservation | undefined {
    const existing = this.completedResult(workspaceId, jobId, leaseToken);
    if (existing) return existing;
    if (!this.validateLease(workspaceId, jobId, leaseToken, now)) return undefined;
    const job = this.jobs.get(jobId)!;
    job.status = 'completed';
    job.completedLeaseToken = leaseToken;
    job.observation = observation;
    delete job.leaseToken;
    delete job.leaseExpiresAt;
    return observation;
  }

  completedResult(workspaceId: string, jobId: string, leaseToken: string): CandidateObservation | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.workspaceId !== workspaceId || job.status !== 'completed' || job.completedLeaseToken !== leaseToken) return undefined;
    return job.observation;
  }

  status(workspaceId: string, jobId: string, now = Date.now()): RenderJob & { failure?: string; result?: CandidateObservation } | undefined {
    this.expire(now);
    const job = this.jobs.get(jobId);
    return job?.workspaceId === workspaceId
      ? { ...this.publicJob(job), ...(job.failure ? { failure: job.failure } : {}), ...(job.observation ? { result: job.observation } : {}) }
      : undefined;
  }

  fail(workspaceId: string, jobId: string, leaseToken: string, reason: string, now = Date.now()): boolean {
    this.expire(now);
    const job = this.jobs.get(jobId);
    if (!job || job.workspaceId !== workspaceId || job.status !== 'leased' || job.leaseToken !== leaseToken) return false;
    job.status = 'failed';
    job.failure = reason.slice(0, 1_000);
    delete job.leaseToken;
    delete job.leaseExpiresAt;
    return true;
  }

  private expire(now: number): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'pending' && Date.parse(job.deadlineAt) <= now) {
        job.status = 'failed';
        job.failure = 'RENDER_TIMEOUT';
      } else if (job.status === 'leased' && (job.leaseExpiresAt ?? 0) <= now) {
        if (Date.parse(job.deadlineAt) <= now) {
          job.status = 'failed';
          job.failure = 'RENDER_TIMEOUT';
        } else {
          job.status = 'pending';
          delete job.leaseToken;
          delete job.leaseExpiresAt;
        }
      }
    }
  }

  private publicJob(job: JobRecord): RenderJob {
    const {
      leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt, completedLeaseToken: _completedLeaseToken,
      observation: _observation, failure: _failure, ...result
    } = job;
    return result;
  }
}
