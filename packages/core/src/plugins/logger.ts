import type { Message } from "@deepseek-ai/cordis";
import ConsoleExporter from "@deepseek-ai/cordis-plugin-logger-console";

/**
 * Cordis log exporter that writes to stderr.
 *
 * The upstream console exporter calls `console.log`, which is stdout, and stdout on this surface carries the assistant's answer and nothing else. A profile that mounts the upstream exporter therefore interleaves framework log records with the model's response and breaks every pipe that reads it. Rendering is inherited unchanged, so a record looks exactly as it did before; only the stream it lands on differs.
 */
export default class StderrConsoleExporter extends ConsoleExporter {
  override export(message: Message): void {
    process.stderr.write(`${this.render(message)}\n`);
  }
}
