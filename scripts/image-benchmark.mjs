// Run a frozen image benchmark plan without changing application model settings.
// Usage: node --import tsx scripts/image-benchmark.mjs <plan.json> [--run]
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { toFile } from 'openai';
import sharp from 'sharp';
import { getOpenAIClient } from '../server/openaiClient.ts';

const [planArgument, mode] = process.argv.slice(2);
if (!planArgument || (mode && mode !== '--run')) {
  throw new Error('Usage: node --import tsx scripts/image-benchmark.mjs <plan.json> [--run]');
}
const planPath = path.resolve(planArgument);
const directory = path.dirname(planPath);
const plan = JSON.parse(await readFile(planPath, 'utf8'));
const prompt = (await readFile(path.join(directory, plan.promptFile), 'utf8')).trimEnd();
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (hash(prompt) !== plan.promptSha256) throw new Error('Prompt hash does not match the frozen plan.');
if (!['images.edit', 'images.generate'].includes(plan.endpoint)) throw new Error('Unsupported endpoint.');
if (plan.n !== 1) throw new Error('This benchmark retains one first-attempt sample per condition.');
if (plan.output_format !== 'png') throw new Error('Use PNG to preserve the original output.');
const referenceBuffers = await Promise.all(plan.references.map(async (reference) => {
  const bytes = await readFile(path.join(directory, reference.file));
  if (hash(bytes) !== reference.sha256) throw new Error(`Reference hash changed: ${reference.file}`);
  return { ...reference, bytes };
}));
const ids = new Set();
for (const variant of plan.variants) {
  if (!/^[a-z0-9-]+$/.test(variant.id) || ids.has(variant.id)) throw new Error('Invalid or duplicate variant ID.');
  if (!variant.model.startsWith('gpt-image-')) throw new Error('Expected a GPT Image model.');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(variant.quality)) throw new Error('Use an explicit quality setting.');
  ids.add(variant.id);
}
console.log(JSON.stringify({ status: mode === '--run' ? 'validated' : 'dry-run', endpoint: plan.endpoint,
  size: plan.size, promptSha256: hash(prompt), references: plan.references, variants: plan.variants }));
if (mode !== '--run') process.exit(0);

dotenv.config({ path: path.resolve('.env.local'), quiet: true });
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
const client = getOpenAIClient(); // 20-minute transport timeout, no automatic retries.
const results = await Promise.allSettled(plan.variants.map(async (variant) => {
  const resultPath = path.join(directory, `${variant.id}.result.json`);
  const requestPath = path.join(directory, `${variant.id}.request.json`);
  for (const file of [resultPath, requestPath, path.join(directory, `${variant.id}.png`)]) {
    const exists = await access(file).then(() => true, () => false);
    if (exists) throw new Error(`Refusing to repeat or overwrite an existing attempt: ${file}`);
  }
  const requested = { model: variant.model, quality: variant.quality, size: plan.size,
    n: plan.n, output_format: plan.output_format };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const request = { variant: variant.id, startedAt, endpoint: plan.endpoint, requested,
    promptSha256: hash(prompt), references: plan.references, automaticRetries: 0 };
  await writeFile(requestPath, JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ variant: variant.id, status: 'started', startedAt }));
  let responseMetadata;
  try {
    const image = await Promise.all(referenceBuffers.map((reference) =>
      toFile(reference.bytes, reference.file, { type: 'image/png' })));
    const payload = { ...requested, prompt, ...(plan.endpoint === 'images.edit' ? { image } : {}) };
    const call = plan.endpoint === 'images.edit' ? client.images.edit(payload) : client.images.generate(payload);
    const { data, response, request_id } = await call.withResponse();
    const elapsedSeconds = (performance.now() - started) / 1000;
    const { data: images, ...metadata } = data;
    responseMetadata = { ...metadata, requestId: request_id ?? response.headers.get('x-request-id') };
    // Persist usage before decoding so a local save failure cannot hide a billed response.
    await writeFile(path.join(directory, `${variant.id}.response.json`), JSON.stringify(responseMetadata, null, 2) + '\n', { flag: 'wx' });
    if (images?.length !== 1 || !images[0].b64_json) throw new Error('Expected one base64 image.');
    const bytes = Buffer.from(images[0].b64_json, 'base64');
    const file = `${variant.id}.png`;
    await writeFile(path.join(directory, file), bytes, { flag: 'wx' });
    const dimensions = await sharp(bytes).metadata();
    const result = { ...request, status: 'completed', completedAt: new Date().toISOString(),
      elapsedSeconds, response: responseMetadata, output: { file, sha256: hash(bytes), bytes: bytes.length,
        width: dimensions.width, height: dimensions.height, format: dimensions.format },
      revisedPrompt: images[0].revised_prompt ?? null };
    await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ variant: variant.id, status: 'completed', elapsedSeconds,
      file, usage: data.usage, returnedQuality: data.quality, dimensions: `${dimensions.width}x${dimensions.height}` }));
    return result;
  } catch (error) {
    const failure = { ...request, status: 'failed', completedAt: new Date().toISOString(),
      elapsedSeconds: (performance.now() - started) / 1000, response: responseMetadata,
      error: { name: error.name, message: error.message, status: error.status, code: error.code,
        requestId: error.request_id, causeCode: error.cause?.code } };
    await writeFile(resultPath, JSON.stringify(failure, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ variant: variant.id, status: 'failed', error: failure.error }));
    throw error;
  }
}));
const failed = results.filter((result) => result.status === 'rejected');
console.log(JSON.stringify({ status: failed.length ? 'incomplete' : 'completed', completed: results.length - failed.length,
  failed: failed.length, errors: failed.map((result) => result.reason.message) }));
process.exit(failed.length ? 1 : 0);
