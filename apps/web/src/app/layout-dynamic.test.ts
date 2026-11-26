import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The root layout makes every page render per request (ADR-0188). Without it
 * `next build` prerenders `/_not-found` to a file, `next start` serves that
 * file for every unknown address, and its scripts carry no nonce, so the
 * browser refuses all of them: 0 of 11 in RD-11b's count.
 *
 * Read with the TypeScript parser, so a comment or a string naming the line
 * does not count, and the value must be the literal Next.js reads at build.
 */
const LAYOUT = new URL("./layout.tsx", import.meta.url);

/** Each `export const dynamic = …` of a source file, as the text of its value. */
function exportedDynamic(text: string): string[] {
  const file = ts.createSourceFile("layout.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "dynamic") continue;
      const value = declaration.initializer;
      const literal = value !== undefined && ts.isStringLiteral(value) ? value.text : value?.getText(file);
      found.push(`${exported ? "export " : ""}${constant ? "const" : "let"} ${literal ?? "(none)"}`);
    }
  }
  return found;
}

describe("the root layout", () => {
  it('exports dynamic = "force-dynamic" once, so the 404 page renders per request with the nonce', () => {
    expect(exportedDynamic(readFileSync(LAYOUT, "utf8"))).toEqual(["export const force-dynamic"]);
  });

  it.each([
    ["the line removed", 'export const metadata = { title: "t" };'],
    ["set to auto", 'export const dynamic = "auto";'],
    ["only in a comment", '// export const dynamic = "force-dynamic";'],
    ["not exported", 'const dynamic = "force-dynamic";'],
    ["a template, not a literal", "export const dynamic = `force-dynamic`;"],
  ])("would fail with %s", (_case, source) => {
    expect(exportedDynamic(source)).not.toEqual(["export const force-dynamic"]);
  });
});
