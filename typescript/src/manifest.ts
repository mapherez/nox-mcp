import { Ajv } from 'ajv';
import policy from './tool-schema-policy.json' with { type: 'json' };
import { toolManifestSchema } from './contracts.generated.js';
import defaults from './defaults.json' with { type: 'json' };
const own = (value: object, key: string) => Object.hasOwn(value, key);
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Compile the shared, offline draft-07 tool profile. Never coerce or mutate data. */
export function compileToolSchema(schema: unknown): (value: unknown) => boolean {
    const root = structuredClone(schema);
    const walk = (node: any, path: Set<any>, depth: number): any => {
        if (depth > policy.maxDepth || path.has(node))
            throw new Error('Recursive or excessive tool schema');
        if (typeof node === 'boolean')
            return node;
        if (!object(node))
            throw new Error('Invalid tool schema');
        const next = new Set(path).add(node);
        node = { ...node };
        let referenced: unknown;
        let hasReference = false;
        for (const key of Object.keys(node))
            if (!policy.keywords.includes(key) && !key.startsWith('x-'))
                throw new Error(`Unsupported schema keyword: ${key}`);
        if (own(node, '$schema') && node.$schema !== policy.dialect)
            throw new Error('Unsupported schema dialect');
        if (own(node, '$ref')) {
            if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#/'))
                throw new Error('Only local JSON Pointer references are supported');
            if (Object.keys(node).some(key => !['$ref', '$schema', 'definitions', ...policy.annotations].includes(key) && !key.startsWith('x-')))
                throw new Error('Assertion siblings of $ref are ambiguous');
            let target: any = root;
            for (const part of node.$ref.slice(2).split('/')) {
                if (/~(?![01])/.test(part))
                    throw new Error('Invalid JSON Pointer escape');
                const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
                if (Array.isArray(target) && !/^(0|[1-9][0-9]*)$/.test(key))
                    throw new Error('Invalid array pointer');
                if ((!object(target) && !Array.isArray(target)) || !own(target, key))
                    throw new Error('Unknown schema reference');
                target = (target as any)[key];
            }
            referenced = walk(target, next, depth + 1);
            hasReference = true;
        }
        const portablePattern = (pattern: unknown) => {
            if (typeof pattern !== 'string')
                throw new Error('Invalid regular expression');
            let result = '', inside = false;
            for (let i = 0; i < pattern.length; i++) {
                const char = pattern[i];
                if (char === '\\' && i + 1 < pattern.length) {
                    const next = pattern[++i], lower = next.toLowerCase();
                    const range = (policy.asciiClasses as Record<string, string>)[lower];
                    if (range) {
                        if (inside && next !== lower)
                            throw new Error('Negated shorthand inside a class is not portable');
                        result += inside ? range : `[${next === lower ? '' : '^'}${range}]`;
                    }
                    else if ('nrtfv'.includes(next) || '.^$|?*+()[]{}\\'.includes(next))
                        result += '\\' + next;
                    else if (next === '/' || next === '-')
                        result += next === '-' ? '\\x2d' : '/';
                    else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(pattern.slice(i + 1, i + 3))) {
                        result += '\\x' + pattern.slice(i + 1, i + 3);
                        i += 2;
                    }
                    else
                        throw new Error('Escape outside portable regular-expression profile');
                }
                else {
                    if (char === '\\')
                        throw new Error('Incomplete regular-expression escape');
                    if (!inside && char === '(' && (pattern[i + 1] === '*' || (pattern[i + 1] === '?' && pattern[i + 2] !== ':')))
                        throw new Error('Unsupported regular-expression group');
                    if (inside && (char === '[' || ['&&', '--', '~~'].includes(pattern.slice(i, i + 2))))
                        throw new Error('Nonportable character class');
                    if (char === '[') {
                        inside = true;
                        if (pattern[i + 1] === ']' || pattern.slice(i + 1, i + 3) === '^]')
                            throw new Error('Empty character class');
                    }
                    if (char === ']')
                        inside = false;
                    result += !inside && char === '.' ? '[^\n\r\u2028\u2029]' : !inside && char === '$' ? '(?![\\s\\S])' : char;
                }
            }
            new RegExp(result, 'u');
            return result;
        };
        if (own(node, 'pattern'))
            node.pattern = portablePattern(node.pattern);
        if (own(node, 'multipleOf') && (!Number.isSafeInteger(node.multipleOf) || node.multipleOf <= 0))
            throw new Error('Portable multipleOf requires a positive safe integer');
        if (object(node.patternProperties)) {
            const normalized: Record<string, unknown> = Object.create(null);
            for (const [key, value] of Object.entries(node.patternProperties)) {
                const pattern = portablePattern(key);
                if (own(normalized, pattern))
                    throw new Error('Colliding normalized patterns');
                normalized[pattern] = value;
            }
            node.patternProperties = normalized;
        }
        for (const key of policy.maps)
            if (own(node, key)) {
                if (!object(node[key]))
                    throw new Error('Invalid schema map');
                node[key] = { ...node[key] };
                for (const [name, child] of Object.entries(node[key]))
                    node[key][name] = walk(child, next, depth + 1);
            }
        for (const key of policy.single)
            if (own(node, key))
                node[key] = walk(node[key], next, depth + 1);
        for (const key of policy.arrays)
            if (own(node, key)) {
                if (!Array.isArray(node[key]) || !node[key].length)
                    throw new Error('Invalid schema alternatives');
                node[key] = node[key].map((child: unknown) => walk(child, next, depth + 1));
            }
        if (own(node, 'format')) {
            const pattern = (policy.formats as Record<string, string>)[node.format];
            if (!pattern)
                throw new Error('Unsupported asserted format');
            node.allOf = [...(node.allOf ?? []), { pattern: portablePattern(pattern) }];
        }
        return hasReference ? referenced : node;
    };
    const prepared = walk(root, new Set(), 0);
    const ajv = new Ajv({ strict: false, validateFormats: false, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true });
    const validate = ajv.compile(prepared);
    return value => validate(value) as boolean;
}
export function validateToolValue(schema: unknown, value: unknown): boolean {
    try {
        return compileToolSchema(schema)(value);
    }
    catch {
        return false;
    }
}
/** Structural validation is separate; this operation requires executable tools. */
export function loadToolManifest(value: unknown) {
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded) > defaults.maxPayloadBytes)
        throw new Error('Manifest payload limit or non-JSON document');
    if (typeof value === 'string') {
        value = JSON.parse(value);
    }
    const manifest = toolManifestSchema.parse(value);
    if (manifest.protocolVersion !== defaults.bridgeProtocolVersion)
        throw new Error('Unsupported executable protocol');
    const names = new Set<string>();
    for (const tool of manifest.tools) {
        if (names.has(tool.name))
            throw new Error('Duplicate executable tool');
        names.add(tool.name);
        for (const schema of [tool.inputSchema, tool.outputSchema]) {
            if (schema.type !== 'object')
                throw new Error('Executable tool schemas must declare type object');
            compileToolSchema(schema);
        }
    }
    return manifest;
}
