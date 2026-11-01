import { modelIdSchema, type ModelId } from '@av/contracts';

const issued = Symbol('serialized GitHub workflow');
export interface PublicationAuthority {
  readonly [issued]: true;
  readonly model: ModelId;
  readonly environment: 'staging' | 'production';
  readonly group: string;
  readonly runId: string;
}

/** Operational exclusion comes from the shared workflow concurrency group, not this receipt. */
export function workflowAuthority(env: NodeJS.ProcessEnv = process.env): PublicationAuthority {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || !['Forecast sample', 'Forecast maintenance'].includes(env.GITHUB_WORKFLOW ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !['staging', 'production'].includes(env.TARGET_ENV ?? '') || env.MODEL !== 'gfs') {
    throw new Error('Publication mutations require the serialized forecast or maintenance workflow on main');
  }
  const model = modelIdSchema.parse(env.MODEL), environment = env.TARGET_ENV as 'staging' | 'production';
  return { [issued]: true, model, environment, group: `forecast-${environment}-${model}`, runId: env.GITHUB_RUN_ID! };
}

export function assertAuthority(authority: PublicationAuthority, model: ModelId): void {
  if (!authority || authority[issued] !== true || authority.model !== model || authority.group !== `forecast-${authority.environment}-${model}`) throw new Error('Missing matching serialized publication authority');
}
