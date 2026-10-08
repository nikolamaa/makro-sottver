/** Collects human-readable import problems, capped so a broken 5000-row file cannot flood the preview. */

const MAX_REPORTED = 200;

export class ProblemLog {
  private readonly messages: string[] = [];
  private hidden = 0;

  /** Record one problem, e.g. "Row 4: missing body". */
  add(message: string): void {
    if (this.messages.length < MAX_REPORTED) this.messages.push(message);
    else this.hidden++;
  }

  /** Total number of problems recorded (including the ones not shown). */
  get count(): number {
    return this.messages.length + this.hidden;
  }

  /** Messages for the preview; ends with a summary line when some were cut off. */
  toArray(): string[] {
    if (!this.hidden) return [...this.messages];
    return [...this.messages, `...and ${this.hidden} more problem(s) not shown.`];
  }
}
