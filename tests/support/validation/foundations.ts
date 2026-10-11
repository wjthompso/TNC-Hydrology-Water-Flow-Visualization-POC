import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ApprovedMetadataChange,
  TestCatalog,
  TestEnforcement,
} from '../catalog/test-catalog.ts';

/**
 * Canonical catalog and fixture validation. The production test runner and
 * catalog self-tests both call this module so structural schema checks and
 * cross-record rules cannot drift apart.
 */

interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  exclusiveMinimum?: number;
  uniqueItems?: boolean;
  pattern?: string;
  format?: string;
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
}

const METADATA_KEYS = new Set([
  '$schema',
  '$id',
  '$defs',
  'title',
  'description',
]);
const HANDLED_KEYS = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'minLength',
  'exclusiveMinimum',
  'uniqueItems',
  'pattern',
  'format',
  'allOf',
  'if',
  'then',
]);

const testCatalogSchemaPath = fileURLToPath(
  new URL('../catalog/test-catalog.schema.json', import.meta.url),
);
const fixtureSchemaPath = fileURLToPath(
  new URL('../../fixtures/manifests/fixture-manifest.schema.json', import.meta.url),
);

let testCatalogSchemaCache: JsonSchema | undefined;
let fixtureSchemaCache: JsonSchema | undefined;

function readSchema(schemaPath: string): JsonSchema {
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchema;
}

function testCatalogSchema(): JsonSchema {
  testCatalogSchemaCache ??= readSchema(testCatalogSchemaPath);
  return testCatalogSchemaCache;
}

function fixtureSchema(): JsonSchema {
  fixtureSchemaCache ??= readSchema(fixtureSchemaPath);
  return fixtureSchemaCache;
}

function childPath(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(instance: unknown, typeName: string): boolean {
  switch (typeName) {
    case 'object':
      return isPlainObject(instance);
    case 'array':
      return Array.isArray(instance);
    case 'null':
      return instance === null;
    case 'string':
      return typeof instance === 'string';
    case 'number':
      return typeof instance === 'number' && Number.isFinite(instance);
    case 'boolean':
      return typeof instance === 'boolean';
    case 'integer':
      return typeof instance === 'number' && Number.isInteger(instance);
    default:
      return false;
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function resolveSchema(schema: JsonSchema, root: JsonSchema): JsonSchema | undefined {
  if (!schema.$ref) return schema;
  if (!schema.$ref.startsWith('#/$defs/')) return undefined;
  return root.$defs?.[schema.$ref.slice('#/$defs/'.length)];
}

function validateWithSchema(
  schema: JsonSchema,
  instance: unknown,
  instancePath: string,
  root: JsonSchema,
  errors: string[],
): void {
  for (const key of Object.keys(schema)) {
    if (!METADATA_KEYS.has(key) && !HANDLED_KEYS.has(key)) {
      errors.push(`Schema: ${instancePath} uses unsupported keyword ${key}.`);
    }
  }

  const resolved = resolveSchema(schema, root);
  if (!resolved) {
    errors.push(`Schema: ${instancePath} has unresolved reference ${schema.$ref}.`);
    return;
  }
  schema = resolved;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((typeName) => matchesType(instance, typeName))) {
      errors.push(`Schema: ${instancePath} must be ${types.join(' or ')}.`);
      return;
    }
  }

  if (schema.const !== undefined && !Object.is(instance, schema.const)) {
    errors.push(`Schema: ${instancePath} must be ${JSON.stringify(schema.const)}.`);
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, instance))) {
    errors.push(
      `Schema: ${instancePath} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}.`,
    );
  }

  if (typeof instance === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push(
        `Schema: ${instancePath} must be at least ${schema.minLength} characters.`,
      );
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(instance)) {
      errors.push(`Schema: ${instancePath} must match ${schema.pattern}.`);
    }
    if (schema.format === 'date' && !isCalendarDate(instance)) {
      errors.push(`Schema: ${instancePath} must be a calendar date.`);
    }
  }

  if (typeof instance === 'number' && schema.exclusiveMinimum !== undefined) {
    if (!(instance > schema.exclusiveMinimum)) {
      errors.push(
        `Schema: ${instancePath} must be greater than ${schema.exclusiveMinimum}.`,
      );
    }
  }

  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(`Schema: ${instancePath} must contain at least ${schema.minItems} items.`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(instance.map((item) => JSON.stringify(item)));
      if (seen.size !== instance.length) {
        errors.push(`Schema: ${instancePath} must contain unique items.`);
      }
    }
    if (schema.items) {
      instance.forEach((item, index) => {
        validateWithSchema(schema.items as JsonSchema, item, childPath(instancePath, index), root, errors);
      });
    }
  }

  if (isPlainObject(instance)) {
    for (const key of schema.required ?? []) {
      if (!(key in instance)) errors.push(`Schema: ${instancePath} is missing ${key}.`);
    }
    if (schema.properties) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in instance) {
          validateWithSchema(
            propertySchema,
            instance[key],
            childPath(instancePath, key),
            root,
            errors,
          );
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(instance)) {
        if (!(key in schema.properties)) {
          errors.push(`Schema: ${instancePath} has unsupported property ${key}.`);
        }
      }
    }
  }

  for (const branch of schema.allOf ?? []) {
    validateWithSchema(branch, instance, instancePath, root, errors);
  }
  if (schema.if && schema.then) {
    const conditionErrors: string[] = [];
    validateWithSchema(schema.if, instance, instancePath, root, conditionErrors);
    if (conditionErrors.length === 0) {
      validateWithSchema(schema.then, instance, instancePath, root, errors);
    }
  }
}

/**
 * Catalog test identifiers are classification labels such as FBT-001, not HTML id attributes.
 * Permanent tests use a category prefix and a number. Examples keep the E form, such as FBT-E001.
 */
const permanentCatalogTestIdPattern = /^(FBT|FST|CCT|SST)-[0-9]+$/;
const exampleCatalogTestIdPattern = /^(FBT|FST|CCT|SST)-E[0-9]+$/;
const catalogTestIdentifierPrefixByCategory = {
  'feature-behavior': 'FBT',
  'feature-supporting': 'FST',
  'critical-core': 'CCT',
  'shared-supporting': 'SST',
} as const;

function catalogTestIdentifierErrors(
  id: string,
  category: string,
  kind: 'permanent' | 'example',
): string[] {
  const pattern = kind === 'permanent' ? permanentCatalogTestIdPattern : exampleCatalogTestIdPattern;
  const expectedShape =
    kind === 'permanent'
      ? 'a category prefix and number such as FBT-001'
      : 'a category prefix, E, and number such as FBT-E001';
  if (!pattern.test(id)) {
    return [
      `${id} is not a valid ${kind} catalog test identifier (${expectedShape}). Catalog test identifiers are not HTML id attributes.`,
    ];
  }

  const prefix = id.slice(0, 3);
  const expectedPrefix =
    catalogTestIdentifierPrefixByCategory[
      category as keyof typeof catalogTestIdentifierPrefixByCategory
    ];
  if (expectedPrefix && prefix !== expectedPrefix) {
    return [
      `${id} category ${category} requires catalog test identifier prefix ${expectedPrefix}.`,
    ];
  }
  return [];
}

function hasCompleteApprovalEvidence(change: ApprovedMetadataChange | null): boolean {
  return Boolean(
    change?.reason.trim() &&
      change.affectedBehaviors.length > 0 &&
      change.affectedBehaviors.every((behavior) => behavior.trim()) &&
      change.consequences.trim() &&
      change.approvalEvidence.trim(),
  );
}

function validateCatalogRelations(candidate: TestCatalog): string[] {
  if (
    !Array.isArray(candidate?.featureSets) ||
    !Array.isArray(candidate?.features) ||
    !Array.isArray(candidate?.criticalCoreAreas) ||
    !Array.isArray(candidate?.tests)
  ) {
    return [];
  }

  const errors: string[] = [];
  const featureIds = new Set<string>();
  const featureSetIds = new Set<string>();
  const coreIds = new Set<string>();
  const seenTestIds = new Set<string>();

  for (const featureSet of candidate.featureSets) {
    if (featureSetIds.has(featureSet.id)) {
      errors.push(`Duplicate Feature Set ID: ${featureSet.id}.`);
    }
    featureSetIds.add(featureSet.id);
  }
  for (const feature of candidate.features) {
    if (featureIds.has(feature.id)) errors.push(`Duplicate Feature ID: ${feature.id}.`);
    featureIds.add(feature.id);
  }
  for (const area of candidate.criticalCoreAreas) {
    if (coreIds.has(area.id)) errors.push(`Duplicate Critical Core ID: ${area.id}.`);
    coreIds.add(area.id);
  }

  for (const feature of candidate.features) {
    if (!featureSetIds.has(feature.featureSetId)) {
      errors.push(`Feature ${feature.id} has unknown Feature Set ${feature.featureSetId}.`);
    }
    if (!['active', 'deprecated', 'retired'].includes(feature.lifecycle)) {
      errors.push(`Feature ${feature.id} has invalid lifecycle ${feature.lifecycle}.`);
    }
    if (
      feature.lifecycle !== 'active' &&
      !hasCompleteApprovalEvidence(feature.lifecycleChange)
    ) {
      errors.push(
        `Feature ${feature.id} ${feature.lifecycle} lifecycle requires approval evidence.`,
      );
    }
    if (
      feature.lifecycleChange !== null &&
      !hasCompleteApprovalEvidence(feature.lifecycleChange)
    ) {
      errors.push(`Feature ${feature.id} has incomplete lifecycle change evidence.`);
    }
    if (
      feature.lifecycle === 'active' &&
      feature.lifecycleChange !== null &&
      !feature.lifecycleChange.expectedBehaviorReview?.trim()
    ) {
      errors.push(
        `Feature ${feature.id} reactivation requires an expected-behavior review.`,
      );
    }
    if (
      feature.lifecycle === 'active' &&
      feature.lifecycleChange !== null &&
      !candidate.tests.some(
        (test) =>
          test.category === 'feature-behavior' &&
          test.owner === feature.id &&
          test.enforcement === 'required',
      )
    ) {
      errors.push(
        `Feature ${feature.id} reactivation requires restored required verification.`,
      );
    }
  }

  for (const test of candidate.tests) {
    if (seenTestIds.has(test.id)) errors.push(`Duplicate test ID: ${test.id}.`);
    seenTestIds.add(test.id);
    if (typeof test.id === 'string' && typeof test.category === 'string') {
      errors.push(...catalogTestIdentifierErrors(test.id, test.category, 'permanent'));
    }

    const isShared = test.category === 'shared-supporting';
    const isFeature = test.category.startsWith('feature-');
    const isCore = test.category === 'critical-core';
    const isSupporting =
      test.category === 'feature-supporting' || test.category === 'shared-supporting';

    if (isShared && test.owner !== null) {
      errors.push(`${test.id} Shared Supporting owner must be null.`);
    }
    if (!isShared && test.owner === null) {
      errors.push(`${test.id} must declare an owner.`);
    }
    if (isFeature && test.owner !== null && !featureIds.has(test.owner)) {
      errors.push(`${test.id} has unknown Feature owner ${test.owner}.`);
    }
    if (isCore && test.owner !== null && !coreIds.has(test.owner)) {
      errors.push(`${test.id} has unknown Critical Core owner ${test.owner}.`);
    }
    if (!['required', 'nonblocking', 'disabled'].includes(test.enforcement)) {
      errors.push(`${test.id} has invalid enforcement ${test.enforcement}.`);
    }
    if (
      test.enforcementChange !== null &&
      !hasCompleteApprovalEvidence(test.enforcementChange)
    ) {
      errors.push(`${test.id} has incomplete enforcement change evidence.`);
    }

    const defaultEnforcement: TestEnforcement = isSupporting ? 'nonblocking' : 'required';
    const supportingRequired = isSupporting && test.enforcement === 'required';
    const coreNotRequired = isCore && test.enforcement !== 'required';
    if (supportingRequired) {
      errors.push(`${test.id} Supporting Tests cannot use required enforcement.`);
    } else if (coreNotRequired) {
      errors.push(`${test.id} Critical Core Tests must use required enforcement.`);
    } else if (
      test.enforcement !== defaultEnforcement &&
      !hasCompleteApprovalEvidence(test.enforcementChange)
    ) {
      errors.push(`${test.id} non-default enforcement requires approval evidence.`);
    }
    if (
      test.category === 'feature-behavior' &&
      test.owner !== null &&
      candidate.features.find(({ id }) => id === test.owner)?.lifecycle === 'active' &&
      test.enforcement !== 'required' &&
      !hasCompleteApprovalEvidence(test.enforcementChange)
    ) {
      errors.push(
        `${test.id} active Feature Behavior defaults to required; an exception requires approval evidence.`,
      );
    }
    if (
      test.category === 'feature-behavior' &&
      test.owner !== null &&
      candidate.features.find(({ id }) => id === test.owner)?.lifecycle === 'deprecated' &&
      test.enforcement !== 'required' &&
      !hasCompleteApprovalEvidence(test.enforcementChange)
    ) {
      errors.push(
        `${test.id} deprecated non-required enforcement requires approval evidence.`,
      );
    }
    if (test.regression && !test.bugReference?.trim()) {
      errors.push(`${test.id} regression tests require a bug reference.`);
    }
    if (test.environment === 'browser' && test.browserMode === 'not-applicable') {
      errors.push(`${test.id} browser tests require deterministic or live mode.`);
    }
    if (test.environment === 'non-browser' && test.browserMode !== 'not-applicable') {
      errors.push(`${test.id} non-browser tests require not-applicable browser mode.`);
    }

    const associations = test.additionalFeatureAssociations;
    if (new Set(associations).size !== associations.length) {
      errors.push(`${test.id} contains duplicate additional Feature associations.`);
    }
    for (const association of associations) {
      if (!featureIds.has(association)) {
        errors.push(`${test.id} has unknown Feature association ${association}.`);
      }
      if (association === test.owner) {
        errors.push(`${test.id} repeats its owner as an additional association.`);
      }
    }
  }

  const exampleIds = new Set<string>();
  for (const example of candidate.examples) {
    if (exampleIds.has(example.id) || seenTestIds.has(example.id)) {
      errors.push(`Duplicate test ID: ${example.id}.`);
    }
    exampleIds.add(example.id);
    if (typeof example.id === 'string' && typeof example.category === 'string') {
      errors.push(...catalogTestIdentifierErrors(example.id, example.category, 'example'));
    }
    if (!example.methodology.trim()) {
      errors.push(`${example.id} requires a methodology.`);
    }
    if (
      typeof example.sourceFile !== 'string' ||
      !/\.example\.(?:test|spec)\.ts$/.test(example.sourceFile)
    ) {
      errors.push(
        `${example.id} source file must end with .example.test.ts or .example.spec.ts.`,
      );
    }
    if (example.category === 'feature-behavior' && !featureIds.has(example.owner)) {
      errors.push(`${example.id} has unknown Feature owner ${example.owner}.`);
    }
    if (example.category === 'critical-core' && !coreIds.has(example.owner)) {
      errors.push(`${example.id} has unknown Critical Core owner ${example.owner}.`);
    }
  }

  return errors;
}

export function validateCatalog(candidate: TestCatalog): string[] {
  const schemaErrors: string[] = [];
  validateWithSchema(testCatalogSchema(), candidate, 'testCatalog', testCatalogSchema(), schemaErrors);
  return [...schemaErrors, ...validateCatalogRelations(candidate)];
}

function knownFixtureAssociations(candidate: TestCatalog): Set<string> {
  return new Set([
    'shared',
    ...candidate.features.map(({ id }) => id),
    ...candidate.criticalCoreAreas.map(({ id }) => id),
  ]);
}

export async function validateFixtureManifests(
  projectRoot: string,
  candidate: TestCatalog,
): Promise<string[]> {
  const errors: string[] = [];
  const manifestDirectory = path.join(projectRoot, 'tests/fixtures/manifests');
  const knownAssociations = knownFixtureAssociations(candidate);
  let fileNames: string[];
  try {
    fileNames = readdirSync(manifestDirectory).filter((file) => file.endsWith('.manifest.json'));
  } catch {
    return ['Fixture manifest directory tests/fixtures/manifests cannot be read.'];
  }

  const schema = fixtureSchema();
  for (const file of fileNames) {
    const manifestPath = path.join(manifestDirectory, file);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    } catch {
      errors.push(`${file} is not valid JSON.`);
      continue;
    }
    const schemaErrors: string[] = [];
    validateWithSchema(schema, manifest, file, schema, schemaErrors);
    errors.push(...schemaErrors);
    if (!isPlainObject(manifest) || typeof manifest.fixture !== 'string') continue;

    const fixturePath = path.join(projectRoot, manifest.fixture);
    try {
      const fixture = await readFile(fixturePath);
      const checksum = createHash('sha256').update(fixture).digest('hex');
      if (checksum !== manifest.sha256) {
        errors.push(`${file} checksum does not match ${manifest.fixture}.`);
      }
    } catch {
      errors.push(`${file} fixture ${manifest.fixture} cannot be read.`);
    }

    if (Array.isArray(manifest.associations)) {
      for (const association of manifest.associations) {
        if (typeof association === 'string' && !knownAssociations.has(association)) {
          errors.push(
            `${file} association ${association} is not a known Feature, Critical Core area, or shared.`,
          );
        }
      }
    }
  }

  return errors;
}

export async function validateTestingFoundations(
  projectRoot: string,
  candidate: TestCatalog,
): Promise<string[]> {
  return [
    ...validateCatalog(candidate),
    ...(await validateFixtureManifests(projectRoot, candidate)),
  ];
}
