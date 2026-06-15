/**
 * ASCII Art Header Extension
 *
 * Displays a custom ASCII art header at the top of every Pi session,
 * keeping the keybinding hints and onboarding text intact.
 *
 * Edit the `asciiArt` constant below to add your own art.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// --- YOUR ASCII ART HERE ---
// Each line of your art is one string in the array.
// Keep lines reasonably narrow (under ~70 chars) to avoid terminal wrapping.
const asciiArt: string[] = [
  // Replace these lines with your own ASCII art.
  // Each string is one line. Keep under ~70 chars to avoid wrapping.
  "_________   _...._      .--. ",
  "\\        |.'      '-.   |__| ",
  " \\        .'```'.    '. .--. ",
  "  \\      |       \\     \\|  | ",
  "   |     |        |    ||  | ",
  "   |      \\      /    . |  | ",
  "   |     |\\`'-.-'   .'  |  | ",
  "   |     | '-....-'`    |__| ",
  "  .'     '.                  ",
  "'-----------'   "
];

// --- Keybinding hints (mirrors the built-in compact header) ---
function buildKeybindingHints(theme: Theme): string {
  // We can't import keyText/keyHint from internal modules, so we use
  // the well-known default keybindings directly.
  const dim = (text: string) => theme.fg("dim", text);
  const muted = (text: string) => theme.fg("muted", text);

  const hint = (key: string, desc: string) => `${dim(key)}${muted(" " + desc)}`;

  return [
    hint("ctrl+c", "interrupt"),
    hint("ctrl+k/ctrl+d", "clear/exit"),
    hint("/", "commands"),
    hint("!", "bash"),
    hint("space", "more"),
  ].join(muted(" \u00b7 "));
}

function buildHeader(theme: Theme): string[] {
  const lines: string[] = [];

  // ASCII art in accent color
  if (asciiArt.length > 0) {
    const accent = (text: string) => theme.fg("accent", text);
    for (const line of asciiArt) {
      lines.push(accent(line));
    }
    lines.push(""); // blank line after art
  }

  // Version + keybinding hints line
  const logo = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${VERSION}`);
  lines.push(logo);
  lines.push(buildKeybindingHints(theme));

  // Onboarding
  const onboarding = theme.fg(
    "dim",
    `press ${theme.fg("dim", "space")} to show full startup help and loaded resources.`,
  );
  lines.push(onboarding);
  lines.push(
    theme.fg(
      "dim",
      "pi can explain its own features and look up its docs. ask it how to use or extend pi.",
    ),
  );

  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => {
      return {
        render(width: number): string[] {
          const lines = buildHeader(theme);
          // Truncate every line to fit the terminal width
          return lines.map((line) => truncateToWidth(line, width));
        },
        invalidate() {},
      };
    });
  });

  // Command to restore built-in header
  pi.registerCommand("builtin-header", {
    description: "Restore built-in header with keybinding hints",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
