import type { WriteStream } from "node:tty";
import type { Message } from "@deepseek-ai/cordis";
import ConsoleExporter, { type ColorSupportLevel } from "@deepseek-ai/cordis-plugin-logger-console";

/**
 * Color level of the stream this exporter writes to.
 *
 * The inherited defaults probe stdout, which stopped being the stream the records land on, so a redirected stderr would keep receiving escape sequences and a stderr still attached to the terminal would lose its colors. `getColorDepth` is defined on a stream exactly when it is a TTY and reads the same `FORCE_COLOR`, `NO_COLOR`, `TERM` and `COLORTERM` signals the upstream probe does, so its bit depth stands in for that probe on the other stream.
 */
function stderrColorLevel(): ColorSupportLevel {
  const stderr: Partial<WriteStream> = process.stderr;
  if (typeof stderr.getColorDepth !== "function") return 0;
  const depth = stderr.getColorDepth();
  if (depth >= 24) return 3;
  if (depth >= 8) return 2;
  return depth >= 4 ? 1 : 0;
}

/**
 * Cordis log exporter that writes to stderr.
 *
 * The upstream console exporter calls `console.log`, which is stdout, and stdout on this surface carries the assistant's answer and nothing else. A profile that mounts the upstream exporter therefore interleaves framework log records with the model's response and breaks every pipe that reads it. Rendering is inherited unchanged, so a record looks exactly as it did before; only the stream it lands on differs.
 *
 * The entry name that mounts this class is hardened in `normalizeConsoleLoggerConfig` beside the upstream one, because the config it takes is the upstream config.
 */
export default class StderrConsoleExporter extends ConsoleExporter {
  override getDefaults(): ReturnType<ConsoleExporter["getDefaults"]> {
    return { ...super.getDefaults(), colors: stderrColorLevel() };
  }

  override export(message: Message): void {
    process.stderr.write(`${this.render(message)}\n`);
  }
}
