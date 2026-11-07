import * as path from 'path';
import {
  BUILD_TOOLS, BuildTool, PINNED_TEMPLATE, TEMPLATE_VERSIONS, TemplateVersion, VARIANTS, Variant, createPlugin, defaultAuthor, nameProblem, slugify,
} from '@decky-toolkit/client/scaffold';
import { InvalidOption } from './device';

function oneOf<T extends string>(what: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InvalidOption(`${what} must be one of ${allowed.join(', ')}`);
}

/** `scaffold-test` → `Scaffold Test`. */
export function nameFromDir(dir: string): string {
  return path.basename(path.resolve(dir)).split(/[-_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export interface NewOptions {
  dir?: string;
  name?: string;
  author?: string;
  variant?: string;
  build?: string;
  template?: string;
}

export interface Created {
  root: string;
  name: string;
  variant: Variant;
  build: BuildTool;
  template: TemplateVersion;
  commit?: string;
  totalMs: number;
}

export async function newPlugin(o: NewOptions, ask: (q: string) => Promise<string>, log: (line: string) => void, signal?: AbortSignal): Promise<Created> {
  const variant = oneOf('variant', o.variant, VARIANTS, 'frontend');
  const build = oneOf('build', o.build, BUILD_TOOLS, 'rollup');
  const template = oneOf('template', o.template, TEMPLATE_VERSIONS, 'pinned');
  const name = (o.name ?? (o.dir ? nameFromDir(o.dir) : await ask('Plugin name: '))).trim();
  const problem = nameProblem(name);
  if (problem) throw new InvalidOption(`name: ${problem.toLowerCase()}`);
  const root = path.resolve(o.dir ?? slugify(name));
  const r = await createPlugin({ name, author: o.author?.trim() || defaultAuthor(), variant, build, template, dir: root, log, signal });
  return { root, name, variant, build, template, commit: r.commit, totalMs: r.ms.total };
}

export function describeCreated(c: Created): string {
  const commit = c.commit ? ` ${c.commit.slice(0, 7)}` : '';
  const which = c.template === 'pinned' ? `pinned${commit}` : `latest${commit}${c.commit === PINNED_TEMPLATE ? ' (same as pinned)' : ''}`;
  return `Created ${c.name} in ${c.root} (${c.variant}, ${c.build}, template ${which}) in ${(c.totalMs / 1000).toFixed(1)} s.`;
}
