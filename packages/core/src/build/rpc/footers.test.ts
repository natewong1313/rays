// Tests removing the footer an earlier build appended to a compiled module.
// Writing footers is tested through whole builds, in build.test.ts.

import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { FOOTER_MARKER, stripFooter } from "./footers.ts";

const markerLine = `\n${FOOTER_MARKER}\n`;

/**
 * Compiled module source, which never contains a footer's marker line, even
 * once a footer follows it: it can't end in the marker without a newline.
 */
const source = fc
  .string()
  .filter((text) => !`${text}\n`.includes(markerLine));

/** Text that may contain marker lines, joined from source and markers. */
const anyText = fc
  .array(fc.oneof(source, fc.constant(markerLine)))
  .map((parts) => parts.join(""));

describe("stripFooter", () => {
  it("removes the footer and keeps the module", () => {
    const module = 'export function main() {\n  return "hi";\n}';
    const footer = `${FOOTER_MARKER}\nregister(main);\n`;
    expect(stripFooter(`${module}\n${footer}`)).toBe(module);
  });

  it("keeps a module without a footer", () => {
    const module = "export function main() {}\n";
    expect(stripFooter(module)).toBe(module);
  });

  it("keeps the marker when it isn't a line of its own", () => {
    const module = `const note = "${FOOTER_MARKER}";\n`;
    expect(stripFooter(module)).toBe(module);
  });

  it.prop([source])("leaves any source without a footer alone", (module) => {
    expect(stripFooter(module)).toBe(module);
  });

  it.prop([source, fc.string()])(
    "gives back the source from before the footer was appended",
    (module, footer) => {
      expect(stripFooter(`${module}${markerLine}${footer}`)).toBe(module);
    },
  );

  it.prop([anyText])("strips nothing more the second time", (text) => {
    const stripped = stripFooter(text);
    expect(stripFooter(stripped)).toBe(stripped);
  });
});
