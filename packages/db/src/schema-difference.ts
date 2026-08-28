/**
 * One difference between two schema descriptions.
 *
 * Its own module so the declaration-level comparison and the live-database
 * comparison can share it without either importing the other.
 */
export interface SchemaDifference {
  /**
   * `table`, `column`, `constraint`, `index` for live differences;
   * `declaration-column`, `declaration-key` when the Drizzle declaration and
   * the canonical snapshot disagree with each other.
   */
  readonly kind: string;
  /** The object the difference is about, qualified. */
  readonly subject: string;
  readonly expected: string;
  readonly actual: string;
}
