import { getProduct, type ModelId } from '@av/contracts';

const issued = Symbol('serialized GitHub workflow');
export interface PublicationAuthority {
  readonly [issued]: true;
  readonly model: ModelId;
  readonly environment: 'staging' | 'production';
  readonly group: string;
  readonly runId: string;
}

/** Shared admission for operational commands running from the main workflow revision. */
export function workflowContext(env: NodeJS.ProcessEnv = process.env): { repository: string; revision: string } {
  const repository = env.GITHUB_REPOSITORY, revision = env.GITHUB_SHA;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Operations require the GitHub workflow on main');
  return { repository, revision };
}

/** Operational exclusion comes from the shared workflow concurrency group, not this receipt. */
export function workflowAuthority(env: NodeJS.ProcessEnv = process.env): PublicationAuthority {
  const { repository } = workflowContext(env);
  const model = env.MODEL;
  const publisher = ['forecast', 'maintenance'].some(name => env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/${name}.yml@refs/heads/main`);
  if (!publisher || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !['staging', 'production'].includes(env.TARGET_ENV ?? '') || !model || !getProduct(model)) {
    throw new Error('Publication mutations require the serialized forecast or maintenance workflow on main');
  }
  const environment = env.TARGET_ENV as 'staging' | 'production';
  return { [issued]: true, model, environment, group: `forecast-${environment}-${model}`, runId: env.GITHUB_RUN_ID! };
}

export function assertAuthority(authority: PublicationAuthority, model: ModelId): void {
  if (!authority || authority[issued] !== true || authority.model !== model || authority.group !== `forecast-${authority.environment}-${model}`) throw new Error('Missing matching serialized publication authority');
}
