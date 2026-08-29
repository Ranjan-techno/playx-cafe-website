import { EnvironmentConfig } from './environment-config';

/**
 * Reusable resource-naming helper.
 *
 * Bind once per stack from that stack's EnvironmentConfig, then call with just the
 * resource's short name:
 *
 *   const resourceName = createResourceNamer(props.envConfig);
 *   resourceName('vpc')              // => 'playx-dev-vpc'
 *   resourceName('booking-function') // => 'playx-dev-booking-function'
 *
 * Switching to the prod config (environments.prod) produces playx-prod-* names from
 * the same helper — no naming logic to duplicate or update.
 */
export function createResourceNamer(config: EnvironmentConfig) {
  return (resource: string): string =>
    `${config.projectCode}-${config.environmentCode}-${resource}`;
}
