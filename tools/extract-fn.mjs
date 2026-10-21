#!/usr/bin/env node
// Print one symbol verbatim, using the TypeScript compiler for exact ranges.
//
// A brace counter is not a parser: a `}` inside a regex, a template literal or a comment ends the function early,
// which is exactly what three review legs reported ("the extract ends after the if block"). tsc already knows the
// syntax tree, so ask it.
//
// Usage: extract-fn.mjs <file> <symbol>
import { readFileSync } from "node:fs";
import ts from "typescript";

const [, , path, symbol] = process.argv;
if (!path || !symbol) {
  process.stderr.write("usage: extract-fn.mjs <file> <symbol>\n");
  process.exit(2);
}
const text = readFileSync(path, "utf8");
const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function nameOf(node) {
  if (!node.name) return null;
  return ts.isIdentifier(node.name) ? node.name.text : null;
}

let found = null;
function visit(node) {
  if (found) return;
  const isDecl =
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
  if (isDecl && nameOf(node) === symbol) {
    // A variable declaration holds the arrow/function; print the whole statement for readability.
    found = ts.isVariableDeclaration(node) && node.parent?.parent ? node.parent.parent : node;
    return;
  }
  ts.forEachChild(node, visit);
}
visit(sf);

if (!found) {
  process.stderr.write(`extract-fn: symbol ${symbol} not found in ${path}\n`);
  process.exit(2);
}
const startLine = sf.getLineAndCharacterOfPosition(found.getFullStart()).line;
const endLine = sf.getLineAndCharacterOfPosition(found.getEnd()).line;
const lines = text.split("\n");
for (let n = startLine; n <= endLine; n += 1) {
  process.stdout.write(`${String(n + 1).padStart(5)}  ${lines[n]}\n`);
}
