import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function inspectWorkflow(source, filename = 'workflow.yml') {
  const document = parseDocument(source, { stringKeys: true });
  const failures = [...document.errors, ...document.warnings].map(
    (error) => `${filename}: invalid YAML: ${error.message}`,
  );
  if (failures.length > 0) return failures;

  try {
    document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return [`${filename}: invalid YAML: ${error.message}`];
  }

  visit(document, {
    Pair(_key, pair) {
      if (pair.key?.value === '<<') {
        failures.push(`${filename}: YAML merge keys are not supported`);
      }
    },
  });

  function dereference(node) {
    return isAlias(node) ? node.resolve(document) : node;
  }

  function inspectReference(mapping, location) {
    if (!mapping.has('uses')) return;
    const original = mapping.get('uses', true);
    const reference = dereference(original);
    const prefix = `${filename}: ${location}.uses`;
    if (!isScalar(reference) || typeof reference.value !== 'string') {
      failures.push(`${prefix}: expected a string action reference`);
      return;
    }

    const value = reference.value.trim();
    if (value.startsWith('./')) return;

    const immutable = value.startsWith('docker://')
      ? value.match(/^docker:\/\/[^\s@]+@sha256:[a-fA-F0-9]{64}$/)
      : value.match(/^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[a-fA-F0-9]{40}$/);
    if (!immutable) {
      failures.push(
        `${prefix}: pin to a full 40-character commit SHA (or Docker sha256 digest): ${value}`,
      );
    }

    const comments = [
      original.comment,
      original.commentBefore,
      reference.comment,
      reference.commentBefore,
    ];
    if (
      !comments.some((comment) =>
        comment?.match(/^\s*v?\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?(?:\s|$)/),
      )
    ) {
      failures.push(`${prefix}: add a release-version comment (e.g. # v1.2.3)`);
    }
  }

  const root = dereference(document.contents);
  const jobs = isMap(root) ? dereference(root.get('jobs', true)) : undefined;
  if (!isMap(jobs) || jobs.items.length === 0) {
    return [...failures, `${filename}: expected a non-empty jobs mapping`];
  }

  for (const { key, value } of jobs.items) {
    const location = `jobs.${key.value}`;
    const job = dereference(value);
    if (!isMap(job)) {
      failures.push(`${filename}: ${location}: expected a job mapping`);
      continue;
    }
    inspectReference(job, location);
    const steps = dereference(job.get('steps', true));
    if (steps === undefined && job.has('uses')) continue;
    if (!isSeq(steps) || steps.items.length === 0) {
      failures.push(
        `${filename}: ${location}: expected non-empty steps or uses`,
      );
      continue;
    }
    for (const [index, value] of steps.items.entries()) {
      const step = dereference(value);
      const stepLocation = `${location}.steps[${index}]`;
      if (!isMap(step)) {
        failures.push(`${filename}: ${stepLocation}: expected a step mapping`);
        continue;
      }
      inspectReference(step, stepLocation);
    }
  }

  return failures;
}

export function checkWorkflows(
  directory = resolve(repoRoot, '.github', 'workflows'),
) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.match(/\.ya?ml$/))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) return [`${directory}: no workflow YAML files found`];
  return files.flatMap((filename) =>
    inspectWorkflow(
      readFileSync(resolve(directory, filename), 'utf8'),
      filename,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const failures = checkWorkflows(process.argv[2]);
    if (failures.length > 0) {
      console.error(`Workflow policy failed:\n${failures.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('Workflow action pin policy passed.');
    }
  } catch (error) {
    console.error(`Workflow policy failed: ${error.message}`);
    process.exitCode = 1;
  }
}
