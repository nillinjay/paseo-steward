const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

function forbidden(specifier) {
  return specifier.startsWith('node:') ||
    /^(?:fs|path|os|child_process|@getpaseo\/plugin\/client|react|react-native|react-dom)(?:\/|$)/.test(specifier) ||
    specifier.startsWith('@react-native/');
}

// Parse syntax rather than matching source text: comments and string contents are not imports.
function scan(directory) {
  const files = [];
  const violations = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(file);
    }
  }
  walk(directory);
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      let literal;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        literal = node.moduleReference.expression;
      } else if (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) literal = node.arguments[0];
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
      if (literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) && forbidden(literal.text)) {
        const { line } = source.getLineAndCharacterOfPosition(literal.getStart(source));
        violations.push({ file: path.relative(directory, file), line: line + 1, specifier: literal.text });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { files, violations };
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'leg48-shared-purity-'));
try {
  const cases = [
    'import path from "node:path";', 'import "fs";', 'const p = require("path");',
    'import os = require("os");', 'export * from "child_process";',
    'import type { X } from "@getpaseo/plugin/client";', 'import("react/jsx-runtime");',
    'import "react-native";', 'type X = import("react-dom/client").X;',
    'require(`@react-native/assets-registry`);', 'import "fs/promises";',
  ];
  fs.mkdirSync(path.join(temporary, 'nested'));
  for (const [index, code] of cases.entries()) {
    fs.writeFileSync(path.join(temporary, 'nested', `bad${index}.tsx`), code);
  }
  fs.writeFileSync(path.join(temporary, 'clean.ts'), '// import "node:path";\nconst text = \'require("fs")\';\nimport { z } from "zod";\n');
  const planted = scan(temporary);
  assert.equal(planted.violations.length, cases.length, 'scanner must detect every planted forbidden import');
  const expectedSpecifiers = [
    'node:path', 'fs', 'path', 'os', 'child_process', '@getpaseo/plugin/client',
    'react/jsx-runtime', 'react-native', 'react-dom/client', '@react-native/assets-registry', 'fs/promises',
  ];
  for (const [index, specifier] of expectedSpecifiers.entries()) {
    assert.ok(planted.violations.some((v) =>
      v.file === path.join('nested', `bad${index}.tsx`) && v.specifier === specifier && v.line === 1),
    `scanner must report the file, line and specifier for ${specifier}`);
  }
  assert.ok(!planted.violations.some((v) => v.file === 'clean.ts'), 'comments and strings must not cause false alarms');
  console.log(`PASS leg48 negative control: detected ${planted.violations.length} forbidden imports`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const real = scan(path.resolve(__dirname, '../shared'));
assert.ok(real.files.length >= 3, `shared scan must include at least 3 files; scanned ${real.files.length}`);
console.log(`leg48 scanned ${real.files.length} shared TypeScript files`);
for (const violation of real.violations) {
  console.error(`FAIL shared/${violation.file}:${violation.line}: forbidden runtime import ${JSON.stringify(violation.specifier)}`);
}
assert.equal(real.violations.length, 0, 'shared/ must import neither Node nor client runtimes');
console.log('PASS leg48: shared/ imports neither runtime');
