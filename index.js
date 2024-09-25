#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import scanner from 'node-recursive-directory';
import OpenAI from 'openai';
import {Low} from "lowdb";
import {JSONFile} from "lowdb/node";

const model = "gpt-4o-mini";
const isVerbose = false;
const program = new Command();

program
  .option('-p, --prefix-file <path>', 'Prefix file to be added to the beginning of each file content')
  .option('-s, --suffix-file <path>', 'Suffix file to be added to the end of each file content')
  .option('-i, --input-dir <path>', 'Input directory containing files to be processed')
  .option('-g, --glossary-file <path>', 'File containing translation glossary')
  .option('-o, --output-dir <path>', 'Output directory where the processed files will be saved')
  .option('-f, --force', 'Force overwrite existing files in the output directory')
  .option('-H, --hugo', 'Enable Hugo front matter processing by removing everything before the first "---" in the AI response')
  .option('-e, --extensions <extensions>', 'Comma-separated list of file extensions to process', '.md,.txt')
  .option('-x, --excluded <parts>', 'Excluded file or directories to be skipped')
  .option('-l, --lang <lang>', 'Target language for translation')
  .on('--help', () => {
    console.log('');
    console.log('Example usage:');
    console.log('  npx bulkai -p prefix.txt -s suffix.txt -i ./input -o ./output -f -H -e .md,.txt --lang es');
  });

program.parse(process.argv);

const options = program.opts();

// Check for OpenAI API key in environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OpenAI API key is not set in the environment variables.');
  process.exit(1);
}

// Load prefix and suffix content if provided
const prefix = options.prefixFile ? await fs.readFile(options.prefixFile, 'utf8') : '';
const suffix = options.suffixFile ? await fs.readFile(options.suffixFile, 'utf8') : '';
const glossary = options.glossaryFile ? await fs.readFile(options.glossaryFile, 'utf8') : '';

const inputPath = path.resolve(options.inputDir);
const outputDir = path.resolve(options.outputDir);

// Parse extensions and excluded files
const extensions = options.extensions.split(',').map(ext => ext.trim());
const excluded = options.excluded ? options.excluded.split(',').map(part => part.trim()) : [];

// Initialize OpenAI API
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Check for --lang option
const targetLang = options.lang || null;

let db;
// Initialize LowDB for file rename mapping
if (targetLang) {
  const inputDirFilenameSafe = options.inputDir.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const dbName = `filename-map-${targetLang}-${inputDirFilenameSafe}.json`;

  const storePath = path.join('data', dbName);
  const adapter = new JSONFile(storePath);
  const defaultData = {files: []}
  db = new Low(adapter, defaultData);
  await db.read();
}

async function translateContent(content, lang) {
  let prompt = [
    'You are technical specification translator',
    'Instructions:',
    `- Translate content from user input to ${lang}`,
    '- Output only the result contents',
    '- Preserve markdown or wiki formatting',
    '- Preserve symbol "_"',
    // '- Return "No content" if no content provided',
    '- Return the same content if it is in the target language already',
  ].join('\n');

  if (glossary) {
    prompt += `\n\nGlossary:\n${glossary}`;
  }

  const completion = await openai.chat.completions.create({
    model: model,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: content },
    ],
  });
  return completion.choices[0].message.content;
}

function getFilenameTranslationCache(filePath) {
  const found = db.data.files.find(({ original, translated }) => {
    if (original === filePath) {
      return translated;
    }
  });

  return found ? found.translated : null;
}

async function getOutputPath(filePath) {
  let outputRelPath = getOutputRelPath(filePath);
  let outputAbsPath = path.join(outputDir, outputRelPath);
  if (!targetLang) return outputAbsPath;

  // Translate filename if --lang is specified
  const outputRelDir = path.dirname(outputRelPath).replace(/^\.$/, '');
  const outputRelDirParts = outputRelDir ? outputRelDir.split(path.sep) : [];
  const outputRelDirTranslated = await Promise.all(outputRelDirParts.map(async part => {
    let translated = getFilenameTranslationCache(part);
    if (!translated) {
      translated = await translateContent(part, targetLang);
      db.data.files.push({ original: part, translated: translated });
      db.write();
    }
    return translated;
  }));

  const filename = path.basename(outputRelPath, path.extname(outputRelPath));
  let translatedFilename = getFilenameTranslationCache(filePath);
  if (!translatedFilename) {
    translatedFilename = await translateContent(filename, targetLang);
    // Save the renamed file mapping to LowDB
    db.data.files.push({ original: filePath, translated: translatedFilename });
    db.write();
  }

  const extension = path.extname(outputRelPath);
  outputRelPath = path.join(...outputRelDirTranslated, `${translatedFilename}${extension}`);

  outputAbsPath = path.join(outputDir, outputRelPath);

  return outputAbsPath;
}

function getOutputRelPath(filePath) {
  return path.resolve(filePath)
    .replace(outputDir, '')
    .replace(inputPath, '')
    .replace(/^[/\\]+/, '');
}

async function processFile(filePath, outputDir, force, hugo) {
  const outputAbsPath = await getOutputPath(filePath);
  const outputRelPath = getOutputRelPath(outputAbsPath);

  if (!force && await fs.pathExists(outputAbsPath)) {
    if (isVerbose) console.log(`File already exists: ${outputAbsPath}`);
    return;
  }

  const outputAbsDir = path.dirname(outputAbsPath);
  await fs.ensureDir(outputAbsDir);

  // console.log without newline
  process.stdout.write(`${targetLang ? 'Translating' : 'Processing'}: ${outputRelPath}`);

  let fileContent = await fs.readFile(filePath, 'utf8');

  // Replace links according to translated filenames
  if (targetLang) {
    db.data.files.forEach(({ original, translated }) => {
      // const originalFilename = path.basename(original);
      const translatedFilename = path.basename(translated);
      const originalWithoutExt = path.basename(original, path.extname(original));

      const linkPattern = new RegExp(`(\\[\\[|!\\[\\[)${originalWithoutExt}(\\]\\]|\\|)`, 'g');
      fileContent = fileContent.replace(linkPattern, (match, p1, p2) => {
        return `${p1}${translatedFilename}${p2}`;
      });
    });
  }

  // Translate file content if --lang is specified
  if (targetLang) {
    fileContent = await translateContent(fileContent, targetLang);
  }
  else {
    const combinedContent = `${prefix}${fileContent}${suffix}`;

    // Send content to OpenAI API
    const completion = await openai.chat.completions.create({
      model: "gpt-4-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: combinedContent },
      ],
    });

    fileContent = completion.choices[0].message.content;
  }


  // Hugo flag processing
  if (hugo) {
    const hugoMatch = fileContent.match(/---/g);
    if (hugoMatch && hugoMatch.length >= 2) {
      const firstIndex = fileContent.indexOf('---');
      fileContent = fileContent.slice(firstIndex);
    }
  }

  // Write the AI's response to the output directory
  await fs.outputFile(outputAbsPath, fileContent);

  console.log(`, saved: ${outputAbsPath}`);
}

// check if filePath contains excluded file or directory
function isExcluded(filePath) {
  return excluded.some(exclude => filePath.includes(exclude));
}

async function main() {
  const files = await scanner(inputPath);

  const filesToProcess = [];
  for (const file of files) {
    if (!extensions.includes(path.extname(file))) continue;
    if (isExcluded(file)) {
      if (isVerbose) console.log(`Excluded: ${file}`);
      continue;
    }
    filesToProcess.push(file);
  }

  if (isVerbose) console.log(`Processing ${filesToProcess.length} files...`);
  for (const file of filesToProcess) {
    await processFile(file, outputDir, options.force, options.hugo);
  }
}

main().catch(console.error);
