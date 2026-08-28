import { adminUrl } from './pg-harness';

/**
 * Vitest setup: supplies the ownership contract every migration run requires.
 *
 * `PRSYSTEM_APPROVED_OPERATOR_OWNERS` is mandatory for `runMigrations` and has
 * no default, so a suite that migrates a scratch database must declare it the
 * way a deployment does — through the environment. Scratch databases are created
 * over the admin connection, so the admin user is their owner.
 *
 * `??=`, not an unconditional assignment: a test that is specifically about the
 * missing or wrong configuration sets or clears the variable itself, and this
 * must not overwrite that.
 */
process.env['PRSYSTEM_APPROVED_OPERATOR_OWNERS'] ??= new URL(adminUrl()).username;
