export const DEPLOYMENT_STAGES = Object.freeze(['development', 'pilot', 'production'] as const);
const NODE_ENV_VALUES = Object.freeze(['development', 'test', 'production'] as const);

export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the deployment stage from explicit server-owned process configuration.
 * NODE_ENV is never a stage fallback: a missing stage or misspelled NODE_ENV fails closed.
 * NODE_ENV=production remains a one-way safety floor and cannot be downgraded.
 */
export function resolveDeploymentStage(env: Environment): DeploymentStage {
  const configured = env.DEPLOYMENT_STAGE;
  if (configured === undefined) {
    throw new Error('DEPLOYMENT_STAGE is required');
  }
  if (!DEPLOYMENT_STAGES.includes(configured as DeploymentStage)) {
    throw new Error(`DEPLOYMENT_STAGE must be one of ${DEPLOYMENT_STAGES.join(', ')}`);
  }

  const nodeEnvironment = env.NODE_ENV;
  if (
    nodeEnvironment !== undefined &&
    !NODE_ENV_VALUES.includes(nodeEnvironment as (typeof NODE_ENV_VALUES)[number])
  ) {
    throw new Error(`NODE_ENV must be one of ${NODE_ENV_VALUES.join(', ')}`);
  }

  if (nodeEnvironment === 'production' && configured === 'development') {
    throw new Error('DEPLOYMENT_STAGE development cannot downgrade NODE_ENV=production');
  }

  return configured as DeploymentStage;
}
