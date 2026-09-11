/**
 * Per-environment API Gateway configuration for the Play X Cafe CDK app.
 *
 * Kept separate from environment-config.ts (identity: project/env/region/account) and the
 * other per-concern config files (see database-config.ts, auth-config.ts), mirroring that
 * split so CORS origins are a one-line change later — e.g. adding a custom domain before
 * prod — without touching the construct that reads them.
 */
export interface ApiConfig {
  /** Origins allowed to call the HTTP API via CORS. */
  corsAllowedOrigins: string[];
}

export const apiConfigs: Record<'dev' | 'prod', ApiConfig> = {
  dev: {
    // The GitHub Pages origin index.html/auth.html are served from during this phase, plus
    // the local static server (`python3 -m http.server 8000`, per CLAUDE.md's "Running it
    // locally") used to develop against this same deployed dev API, plus the GitHub Pages
    // staging frontend at staging.playxcafe.com, plus the production apex and www domains
    // (playxcafe.com / www.playxcafe.com) now that this dev-account API is the one actually
    // serving production traffic. No wildcard — CORS credentials/origin reflection with "*"
    // isn't appropriate even in dev, and the prod config below never gets these extra entries.
    corsAllowedOrigins: [
      'https://ranjan-techno.github.io',
      'http://localhost:8000',
      'https://staging.playxcafe.com',
      'https://playxcafe.com',
      'https://www.playxcafe.com',
    ],
  },
  prod: {
    // TODO: revisit before a prod API exists — likely a custom domain rather than the
    // GitHub Pages origin. Not read by any stack this phase (see bin/infra.ts).
    corsAllowedOrigins: ['https://ranjan-techno.github.io'],
  },
};
