import { DataProviderLinkCount, DataProviderLookupParams } from '../dataProvider';
import { ElementIri, ElementTypeIri } from '../model';
import * as Rdf from '../rdf/rdfModel';

import { SparqlDataProviderSettings } from './sparqlDataProviderSettings';
import {
    BlankBinding, ElementBinding, ElementTypeBinding, FilterBinding, LinkBinding, SparqlResponse,
    isBlankBinding, isRdfBlank, isRdfIri, isRdfLiteral,
} from './sparqlModels';

/**
 * Maximum depth of nested blank nodes to follow when resolving the outer graph
 * of a blank node.
 */
export const MAX_RECURSION_DEEP = 3;

/**
 * IRI prefix for the encoded blank node subtype produced by this module.
 *
 * @see {@link isEncodedBlank}
 */
export const ENCODED_PREFIX = 'urn:reactodia:blank:sparql:';

/**
 * There is no way to refer to an existing blank node from a SPARQL query, and the labels
 * an endpoint returns for one are local to the response they came in. Instead of trying to
 * address a blank node, the whole statement set which describes it is encoded into the
 * element IRI, which makes the identity content-addressed: the same surrounding graph always
 * yields the same IRI, and every request about such an element can be answered locally by
 * decoding it back, without another round-trip to the endpoint.
 *
 * The trade-off is size: the IRI grows linearly with the number of statements attached to
 * the blank node, at roughly 300 characters per statement. {@link MAX_RECURSION_DEEP} bounds
 * how deep nesting can go, but nothing bounds how wide a single blank node can be, so a long
 * RDF list produces a correspondingly long IRI (measured against the W3C Organization
 * ontology: 380-1650 characters for its OWL axioms; a synthetic 100-member list: ~28 KB).
 */
export function isEncodedBlank(iri: string): boolean {
    return iri.startsWith(ENCODED_PREFIX);
}

/**
 * Additional output bindings which {@link BLANK_NODE_QUERY} produces, to be added
 * to the outer projection of the lookup query.
 */
export const BLANK_NODE_QUERY_PARAMETERS = '?blankType ?blankTrgProp ?blankTrg ?blankSrc ?blankSrcProp';

/**
 * Lookup query addition which describes every blank node in `?inst` by its outgoing
 * statements and the statement pointing at it.
 *
 * The three alternatives handle a plain blank node, an RDF list referenced directly
 * and a cell in the middle of an RDF list (which is resolved to the list head, so that
 * a list appears as a single element rather than one element per cell).
 */
export const BLANK_NODE_QUERY = `
    OPTIONAL {
        FILTER (ISBLANK(?inst)).
        {
            ?inst ?blankTrgProp ?blankTrg.
            ?blankSrc ?blankSrcProp ?inst.
            FILTER NOT EXISTS { ?inst rdf:first _:smth1 }.
            BIND("blankNode" as ?blankType)
        } UNION {
            ?inst rdf:rest*/rdf:first ?blankTrg.
            ?blankSrc ?blankSrcProp ?inst.
            _:smth2 rdf:first ?blankTrg.
            BIND(?blankSrcProp as ?blankTrgProp)
            BIND("listHead" as ?blankType)
            FILTER NOT EXISTS { _:smth3 rdf:rest ?inst }.
        } UNION {
            ?listHead rdf:rest* ?inst.
            FILTER NOT EXISTS { _:smth4 rdf:rest ?listHead }.

            ?listHead rdf:rest*/rdf:first ?blankTrg.
            ?blankSrc ?blankSrcProp ?listHead.
            _:smth5 rdf:first ?blankTrg.
            BIND(?blankSrcProp as ?blankTrgProp)
            BIND("listHead" as ?blankType)
        }
    }
`;

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

type EncodedTerm =
    /** Named node. */
    | readonly ['i', string]
    /** Blank node which could not be resolved into an encoded IRI. */
    | readonly ['b', string]
    /** Literal, optionally with a language tag. */
    | readonly ['l', string, string?]
    /** Literal with a datatype other than `xsd:string`. */
    | readonly ['d', string, string];

/**
 * Encoded form of a {@link BlankBinding}.
 *
 * Property names are single letters and the shape is minimal on purpose: every character
 * here ends up repeated in the element IRI of the blank node.
 */
interface EncodedBinding {
    /** {@link BlankBinding.blankType} */
    readonly t: string;
    /** {@link BlankBinding.blankTrgProp} */
    readonly p: EncodedTerm;
    /** {@link BlankBinding.blankTrg} */
    readonly o: EncodedTerm;
    /** {@link BlankBinding.blankSrc} */
    readonly s?: EncodedTerm;
    /** {@link BlankBinding.blankSrcProp} */
    readonly sp?: EncodedTerm;
    /** {@link ElementBinding.class} */
    readonly c?: EncodedTerm;
}

function encodeTerm(term: Rdf.NamedNode | Rdf.BlankNode | Rdf.Literal): EncodedTerm {
    switch (term.termType) {
        case 'NamedNode':
            return ['i', term.value];
        case 'BlankNode':
            return ['b', term.value];
        case 'Literal': {
            if (term.language) {
                return ['l', term.value, term.language];
            } else if (term.datatype && term.datatype.value !== XSD_STRING) {
                return ['d', term.value, term.datatype.value];
            }
            return ['l', term.value];
        }
    }
}

function decodeTerm(
    encoded: EncodedTerm,
    factory: Rdf.DataFactory
): Rdf.NamedNode | Rdf.BlankNode | Rdf.Literal {
    switch (encoded[0]) {
        case 'i':
            return factory.namedNode(encoded[1]);
        case 'b':
            return factory.blankNode(encoded[1]);
        case 'l':
            return factory.literal(encoded[1], encoded[2]);
        case 'd':
            return factory.literal(encoded[1], factory.namedNode(encoded[2]));
        default:
            throw new Error(`Unexpected encoded blank node term: ${JSON.stringify(encoded)}`);
    }
}

/**
 * Encodes the statement set which describes a single blank node into an element IRI.
 *
 * Bindings are deduplicated and sorted, so that the same statement set always produces
 * the same IRI regardless of the order the endpoint returned it in. The blank node label
 * itself is deliberately left out: it is local to the response it came from and would make
 * the IRI change between otherwise identical requests.
 */
export function encodeId(
    blankBindings: ReadonlyArray<BlankBinding>,
    statementLimit?: number
): string {
    const bindingSet = new Map<string, EncodedBinding>();
    for (const binding of blankBindings) {
        const encoded: EncodedBinding = {
            t: binding.blankType.value,
            p: encodeTerm(binding.blankTrgProp),
            o: encodeTerm(binding.blankTrg),
            s: binding.blankSrc ? encodeTerm(binding.blankSrc) : undefined,
            sp: binding.blankSrcProp ? encodeTerm(binding.blankSrcProp) : undefined,
            c: binding.class ? encodeTerm(binding.class) : undefined,
        };
        bindingSet.set(JSON.stringify(encoded), encoded);
    }

    // truncating after the sort keeps the IRI stable: the same statement set always
    // yields the same subset, whichever order the endpoint returned it in
    const orderedKeys = Array.from(bindingSet.keys()).sort();
    const retainedKeys = typeof statementLimit === 'number'
        ? orderedKeys.slice(0, Math.max(statementLimit, 0)) : orderedKeys;
    const normalizedBindings = retainedKeys.map(key => bindingSet.get(key)!);
    return ENCODED_PREFIX + toBase64Url(JSON.stringify(normalizedBindings));
}

/**
 * Encodes the payload as base64url rather than percent-escaping it.
 *
 * A nested blank node is embedded into its parent by its own encoded IRI, and base64url
 * output contains only characters which need no escaping, so nesting costs a flat 4/3 per
 * level. Percent-escaping would escape the escapes, roughly doubling the payload at every
 * level instead.
 */
function toBase64Url(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

/**
 * Decodes an element IRI produced by {@link encodeId} back into the statement set it
 * was made from, or returns `undefined` if the IRI is not an encoded blank node or
 * cannot be parsed.
 */
export function decodeId(
    id: string,
    factory: Rdf.DataFactory
): BlankBinding[] | undefined {
    if (!isEncodedBlank(id)) {
        return undefined;
    }
    let parsed: EncodedBinding[];
    try {
        const encodedPart = id.substring(ENCODED_PREFIX.length);
        parsed = JSON.parse(fromBase64Url(encodedPart)) as EncodedBinding[];
        if (!Array.isArray(parsed)) {
            return undefined;
        }
    } catch {
        /* silently ignore a malformed ID as if it was not an encoded blank node */
        return undefined;
    }

    try {
        // restore the instance IRI which was left out on encoding
        const inst = factory.namedNode(id);
        return parsed.map((encoded): BlankBinding => {
            const binding: BlankBinding = {
                inst,
                blankType: factory.literal(encoded.t),
                blankTrgProp: decodeTerm(encoded.p, factory) as Rdf.NamedNode,
                blankTrg: decodeTerm(encoded.o, factory),
                blankSrc: encoded.s
                    ? decodeTerm(encoded.s, factory) as Rdf.NamedNode | Rdf.BlankNode
                    : undefined,
                blankSrcProp: encoded.sp
                    ? decodeTerm(encoded.sp, factory) as Rdf.NamedNode
                    : undefined,
                class: encoded.c ? decodeTerm(encoded.c, factory) as Rdf.NamedNode : undefined,
            };
            binding.label = createLabelForBlankBinding(binding, factory);
            return binding;
        });
    } catch {
        return undefined;
    }
}

export function createLabelForBlankBinding(
    binding: BlankBinding,
    factory: Rdf.DataFactory
): Rdf.Literal {
    if (binding.blankType.value === 'listHead') {
        return factory.literal('RDFList');
    }
    const {class: classTerm} = binding;
    return factory.literal(
        classTerm ? (Rdf.getLocalName(classTerm.value) ?? classTerm.value) : 'anonymous'
    );
}

/**
 * Deduplicates identical in-flight queries, since the chains being followed
 * often overlap on their leading statements.
 */
class QueryExecutor {
    private readonly running = new Map<string, Promise<SparqlResponse<BlankBinding>>>();

    constructor(
        private readonly queryFunction: (query: string) => Promise<SparqlResponse<BlankBinding>>
    ) {}

    executeQuery(query: string): Promise<SparqlResponse<BlankBinding>> {
        const existing = this.running.get(query);
        if (existing) {
            return existing;
        }
        const execution = this.queryFunction(query).then(response => {
            this.running.delete(query);
            return response;
        }, error => {
            this.running.delete(query);
            throw error;
        });
        this.running.set(query, execution);
        return execution;
    }
}

/**
 * Replaces the raw blank node bindings in a lookup response with bindings whose `inst`
 * is an encoded IRI, resolving nested blank nodes along the way.
 */
export async function updateLookupResults(
    result: SparqlResponse<ElementBinding & FilterBinding>,
    queryFunction: (query: string) => Promise<SparqlResponse<BlankBinding>>,
    settings: SparqlDataProviderSettings,
    factory: Rdf.DataFactory
): Promise<SparqlResponse<ElementBinding & FilterBinding>> {
    const completeBindings: Array<ElementBinding & FilterBinding> = [];
    const blankBindings: Array<BlankBinding & FilterBinding> = [];

    for (const binding of result.results.bindings) {
        if (isBlankBinding(binding)) {
            blankBindings.push(binding as BlankBinding & FilterBinding);
        } else {
            completeBindings.push(binding);
        }
    }

    if (blankBindings.length === 0) {
        return result;
    }

    const processedBindings = await processBlankBindings(
        blankBindings, queryFunction, settings, factory
    );
    return {
        ...result,
        results: {
            ...result.results,
            bindings: completeBindings.concat(processedBindings),
        },
    };
}

/**
 * Groups raw blank node bindings by the blank node they describe, resolves any nested
 * blank nodes they point at and rewrites both the instance and the nested targets into
 * encoded IRIs.
 *
 * The bindings are mutated in place and returned.
 */
export async function processBlankBindings<T extends BlankBinding>(
    blankBindings: readonly T[],
    queryFunction: (query: string) => Promise<SparqlResponse<BlankBinding>>,
    settings: SparqlDataProviderSettings,
    factory: Rdf.DataFactory
): Promise<T[]> {
    const bindingGroupsById = new Map<string, T[]>();
    for (const binding of blankBindings) {
        let group = bindingGroupsById.get(binding.inst.value);
        if (!group) {
            group = [];
            bindingGroupsById.set(binding.inst.value, group);
        }
        group.push(binding);
    }

    const nestedChains: BlankBinding[][] = [];
    for (const binding of blankBindings) {
        if (isRdfBlank(binding.blankTrg)) {
            nestedChains.push([binding]);
        }
    }

    const queryExecutor = new QueryExecutor(queryFunction);
    const loadedGroups = await loadRelatedBlankNodes(nestedChains, queryExecutor, settings, factory);
    const {blankNodeStatementLimit} = settings;
    const idsMap = getEncodedIdDictionary(loadedGroups, factory, blankNodeStatementLimit);

    for (const group of bindingGroupsById.values()) {
        for (const binding of group) {
            const encodedNestedId = idsMap.get(binding.blankTrg.value);
            if (encodedNestedId !== undefined) {
                binding.blankTrg = factory.namedNode(encodedNestedId);
            }
            if (!binding.label) {
                binding.label = createLabelForBlankBinding(binding, factory);
            }
        }
        updateGroupIds(group, encodeId(group, blankNodeStatementLimit), factory);
    }

    return blankBindings.slice();
}

function getEncodedIdDictionary(
    blankBindingGroups: Map<string, BlankBinding[]>,
    factory: Rdf.DataFactory,
    statementLimit: number | undefined
): Map<string, string> {
    const idDictionary = new Map<string, string>();
    for (const [key, group] of blankBindingGroups) {
        const encodedId = encodeId(group, statementLimit);
        idDictionary.set(key, encodedId);
        updateGroupIds(group, encodedId, factory);
    }
    return idDictionary;
}

function updateGroupIds(
    group: BlankBinding[],
    newId: string,
    factory: Rdf.DataFactory
): void {
    const inst = factory.namedNode(newId);
    for (const binding of group) {
        binding.inst = inst;
    }
}

async function loadRelatedBlankNodes(
    blankChains: ReadonlyArray<BlankBinding[]>,
    queryExecutor: QueryExecutor,
    settings: SparqlDataProviderSettings,
    factory: Rdf.DataFactory,
    recursionDeep = 1
): Promise<Map<string, BlankBinding[]>> {
    const loadedBlankBindings = new Map<string, BlankBinding[]>();
    if (recursionDeep > MAX_RECURSION_DEEP || blankChains.length === 0) {
        return loadedBlankBindings;
    }

    const results = await Promise.all(blankChains.map(async chain => ({
        chain,
        response: await queryExecutor.executeQuery(getQueryForChain(chain, settings)),
    })));

    await Promise.all(results.map(async ({chain, response}) => {
        const bindings = response.results.bindings;
        if (bindings.length === 0) {
            return;
        }

        const nestedChains: BlankBinding[][] = [];
        for (const binding of bindings) {
            if (isRdfBlank(binding.blankTrg)) {
                nestedChains.push(chain.concat([binding]));
            }
        }

        const loadedNestedGroups = await loadRelatedBlankNodes(
            nestedChains, queryExecutor, settings, factory, recursionDeep + 1
        );
        const idsMap = getEncodedIdDictionary(
            loadedNestedGroups, factory, settings.blankNodeStatementLimit
        );

        for (const binding of bindings) {
            const encodedNestedId = idsMap.get(binding.blankTrg.value);
            if (encodedNestedId !== undefined) {
                binding.blankTrg = factory.namedNode(encodedNestedId);
            }
            binding.label = createLabelForBlankBinding(binding, factory);

            let group = loadedBlankBindings.get(binding.inst.value);
            if (!group) {
                group = [];
                loadedBlankBindings.set(binding.inst.value, group);
            }
            group.push(binding);
        }
    }));

    return loadedBlankBindings;
}

/**
 * Builds a query which walks the chain of statements from the named node the chain starts at
 * down to the blank node at its end, and describes that blank node.
 *
 * The chain is expressed entirely in IRIs and predicates, since blank node labels from
 * a previous response cannot be used to address anything in a new query.
 */
function getQueryForChain(
    blankNodes: ReadonlyArray<BlankBinding>,
    settings: SparqlDataProviderSettings
): string {
    function getQueryBlock(blankNode: BlankBinding, index: number, maxIndex: number): string {
        // if blankNode has type 'listHead' then its target and target property are artificial,
        // and we can't include them in the chain
        const trustableTrgProp = index === 0 || blankNode.blankType.value !== 'listHead';

        const sourceId = index > 0
            ? `?inst${index - 1}`
            : formatChainTerm(blankNode.blankSrc, `?blankAnySrc${index}`);
        const sourcePropId = trustableTrgProp
            ? (index > 0
                ? `?blankTrgProp${index - 1}`
                : formatChainTerm(blankNode.blankSrcProp, `?blankAnySrcProp${index}`))
            : `?anyType${index}`;

        const instPostfix = index === maxIndex ? '' : index.toString();
        const targetPropId = trustableTrgProp
            ? formatChainTerm(blankNode.blankTrgProp, `?blankAnyTrgProp${index}`)
            : `?anyType0${index}`;

        const firstRelation = index === 0 && blankNode.blankType.value === 'listHead'
            ? `?blankSrc${index} rdf:rest*/rdf:first ?inst${instPostfix}.`
            : `?blankSrc${index} ${targetPropId} ?inst${instPostfix}.`;

        return `
            # ======================
            ${sourceId} ${sourcePropId} ?blankSrc${index}.
            ${firstRelation}
            BIND (${formatChainTerm(blankNode.blankTrgProp, `?blankAnyBind${index}`)} as ?blankSrcProp${index}).
            FILTER (ISBLANK(?inst${instPostfix})).
            {
                ?inst${instPostfix} ?blankTrgProp${instPostfix} ?blankTrg${instPostfix}.
                BIND("blankNode" as ?blankType${instPostfix}).
                FILTER NOT EXISTS { ?inst${instPostfix} rdf:first _:smth1${index} }.
            } UNION {
                ?inst${instPostfix} rdf:rest*/rdf:first ?blankTrg${instPostfix}.
                ?blankSrc${index} ?blankSrcProp${index} ?inst${instPostfix}.
                _:smth2${index} rdf:first ?blankTrg${instPostfix}.
                BIND(?blankSrcProp${index} as ?blankTrgProp${instPostfix})
                BIND("listHead" as ?blankType${instPostfix})
                FILTER NOT EXISTS { _:smth3${index} rdf:rest ?inst${instPostfix} }.
            }
            OPTIONAL {
                ?inst${instPostfix} rdf:type ?class${instPostfix}.
            }
        `;
    }

    const body = blankNodes
        .map((bn, index) => getQueryBlock(bn, index, blankNodes.length - 1))
        .join('\n');
    return `${settings.defaultPrefix}
    SELECT ?inst ?class ?label ?blankTrgProp ?blankTrg ?blankType
        WHERE {
           ${body}
        }
    `;
}

/**
 * Formats a chain term as an IRI, falling back to a fresh variable when the term is
 * missing or is itself a blank node, neither of which can be referenced from a query.
 */
function formatChainTerm(term: Rdf.Term | undefined, fallbackVariable: string): string {
    return isRdfIri(term) ? `<${term.value}>` : fallbackVariable;
}

/**
 * Answers {@link DataProvider.elements} for encoded blank nodes without querying the endpoint.
 *
 * Literal targets of the blank node are surfaced as element properties; targets which are
 * entities of their own become links instead, see {@link links}.
 */
export function elements(
    elementIds: ReadonlyArray<ElementIri>,
    factory: Rdf.DataFactory
): ElementBinding[] {
    const bindings: ElementBinding[] = [];
    for (const id of elementIds) {
        const blankBindings = decodeId(id, factory);
        if (!blankBindings) {
            continue;
        }
        for (const binding of blankBindings) {
            if (isRdfLiteral(binding.blankTrg)) {
                bindings.push({
                    ...binding,
                    propType: binding.blankTrgProp,
                    propValue: binding.blankTrg,
                });
            } else {
                bindings.push(binding);
            }
        }
    }
    return bindings;
}

/**
 * Answers {@link DataProvider.links} for encoded blank nodes without querying the endpoint.
 *
 * Only links where both ends are among the requested elements are returned, matching
 * the behavior of the endpoint-backed query.
 */
export function links(
    elementIds: ReadonlyArray<ElementIri>,
    factory: Rdf.DataFactory
): LinkBinding[] {
    const requested = new Set<string>(elementIds);
    const bindings: LinkBinding[] = [];
    for (const id of elementIds) {
        const blankBindings = decodeId(id, factory);
        if (!blankBindings) {
            continue;
        }
        for (const binding of blankBindings) {
            const {inst, blankSrc, blankSrcProp, blankTrg, blankTrgProp} = binding;
            if (blankSrc && blankSrcProp && requested.has(blankSrc.value)) {
                bindings.push({source: blankSrc, type: blankSrcProp, target: inst});
            }
            if (!isRdfLiteral(blankTrg) && requested.has(blankTrg.value)) {
                bindings.push({source: inst, type: blankTrgProp, target: blankTrg});
            }
        }
    }
    return bindings;
}

/**
 * Answers {@link DataProvider.connectedLinkStats} for an encoded blank node without
 * querying the endpoint.
 */
export function connectedLinkStats(
    elementId: ElementIri,
    factory: Rdf.DataFactory
): DataProviderLinkCount[] {
    const blankBindings = decodeId(elementId, factory);
    if (!blankBindings) {
        return [];
    }

    type MutableLinkCount = {-readonly [K in keyof DataProviderLinkCount]: DataProviderLinkCount[K]};

    const stats = new Map<string, MutableLinkCount>();
    function getOrCreate(linkTypeId: string): MutableLinkCount {
        let count = stats.get(linkTypeId);
        if (!count) {
            count = {id: linkTypeId, inCount: 0, outCount: 0};
            stats.set(linkTypeId, count);
        }
        return count;
    }

    for (const binding of blankBindings) {
        const {blankSrc, blankSrcProp, blankTrg, blankTrgProp} = binding;
        if (isRdfLiteral(blankTrg)) {
            continue;
        }
        if (blankSrc && blankSrcProp) {
            const incoming = getOrCreate(blankSrcProp.value);
            incoming.inCount += 1;
        }
        const outgoing = getOrCreate(blankTrgProp.value);
        outgoing.outCount += 1;
    }

    return Array.from(stats.values());
}

/**
 * Answers {@link DataProvider.lookup} for navigation from an encoded blank node without
 * querying the endpoint, or returns `undefined` when the lookup is not about one.
 */
export function lookup(
    params: DataProviderLookupParams,
    factory: Rdf.DataFactory
): SparqlResponse<ElementBinding & FilterBinding> | undefined {
    let bindings: Array<ElementBinding & FilterBinding>;
    if (params.elementTypeId) {
        return undefined;
    } else if (params.refElementId && params.refElementLinkId) {
        bindings = getAllRelatedByLinkTypeElements(
            params.refElementId, params.refElementLinkId, params.linkDirection, factory
        );
    } else if (params.refElementId) {
        bindings = getAllRelatedElements(params.refElementId, factory);
    } else {
        return undefined;
    }

    if (bindings.length === 0) {
        return undefined;
    }

    if (params.text) {
        const text = params.text.toLowerCase();
        bindings = bindings.filter(
            binding => binding.inst.value.toLowerCase().includes(text)
        );
    }

    return {head: {vars: []}, results: {bindings}};
}

/**
 * Answers the element type query for encoded blank nodes without querying the endpoint.
 */
export function collectElementTypes(
    elementIds: ReadonlyArray<ElementIri>,
    factory: Rdf.DataFactory,
    result: Map<ElementIri, Set<ElementTypeIri>>
): void {
    for (const id of elementIds) {
        const blankBindings = decodeId(id, factory);
        if (!blankBindings) {
            continue;
        }
        for (const binding of blankBindings) {
            if (binding.class) {
                let types = result.get(id);
                if (!types) {
                    types = new Set<ElementTypeIri>();
                    result.set(id, types);
                }
                types.add(binding.class.value);
            }
        }
    }
}

/**
 * Same as {@link collectElementTypes} but shaped as a SPARQL response, for the code paths
 * which merge it with an endpoint response.
 */
export function elementTypes(
    elementIds: ReadonlyArray<ElementIri>,
    factory: Rdf.DataFactory
): ElementTypeBinding[] {
    const bindings: ElementTypeBinding[] = [];
    for (const id of elementIds) {
        const blankBindings = decodeId(id, factory);
        if (!blankBindings) {
            continue;
        }
        for (const binding of blankBindings) {
            if (isRdfIri(binding.inst) && binding.class) {
                bindings.push({inst: binding.inst, class: binding.class});
            }
        }
    }
    return bindings;
}

/**
 * Answers navigation from an encoded blank node over a single link type.
 *
 * The direction is relative to the blank node: `in` collects the entities which point at it,
 * `out` the entities it points at.
 */
function getAllRelatedByLinkTypeElements(
    refElementId: ElementIri,
    refElementLinkId: string,
    linkDirection: 'in' | 'out' | undefined,
    factory: Rdf.DataFactory
): Array<ElementBinding & FilterBinding> {
    const blankBindings = decodeId(refElementId, factory);
    if (!blankBindings) {
        return [];
    }

    const linkType = factory.namedNode(refElementLinkId);
    const bindings: Array<ElementBinding & FilterBinding> = [];
    for (const binding of blankBindings) {
        const {blankSrc, blankSrcProp, blankTrg, blankTrgProp} = binding;
        if (
            linkDirection !== 'out' &&
            blankSrc && blankSrcProp && blankSrcProp.value === refElementLinkId
        ) {
            pushRelated(bindings, blankSrc, linkType, 'in', factory);
        }
        if (
            linkDirection !== 'in' &&
            blankTrgProp.value === refElementLinkId &&
            !isRdfLiteral(blankTrg)
        ) {
            pushRelated(bindings, blankTrg, linkType, 'out', factory);
        }
    }
    return bindings;
}

/**
 * Answers navigation from an encoded blank node over every link type at once.
 *
 * Literal targets are left out: they are the blank node's own properties, not connections.
 */
function getAllRelatedElements(
    refElementId: ElementIri,
    factory: Rdf.DataFactory
): Array<ElementBinding & FilterBinding> {
    const blankBindings = decodeId(refElementId, factory);
    if (!blankBindings) {
        return [];
    }

    const bindings: Array<ElementBinding & FilterBinding> = [];
    for (const binding of blankBindings) {
        const {blankSrc, blankSrcProp, blankTrg, blankTrgProp} = binding;
        if (blankSrc && blankSrcProp) {
            pushRelated(bindings, blankSrc, blankSrcProp, 'in', factory);
        }
        if (!isRdfLiteral(blankTrg)) {
            pushRelated(bindings, blankTrg, blankTrgProp, 'out', factory);
        }
    }
    return bindings;
}

/**
 * Adds the element at the far end of a statement to the result: a named node as-is,
 * an encoded blank node expanded back into the statements which describe it.
 *
 * The link type and the direction are carried over so that the result describes the
 * connection the same way an endpoint-backed lookup does. A named node is returned bare,
 * without a label or a type: {@link SparqlDataProvider.lookup} fills those in, since only
 * the endpoint knows them.
 */
function pushRelated(
    bindings: Array<ElementBinding & FilterBinding>,
    term: Rdf.NamedNode | Rdf.BlankNode,
    linkType: Rdf.NamedNode,
    direction: 'in' | 'out',
    factory: Rdf.DataFactory
): void {
    const connection: FilterBinding = {link: linkType, direction: factory.literal(direction)};
    const nested = isRdfIri(term) ? decodeId(term.value, factory) : undefined;
    if (nested) {
        for (const binding of nested) {
            bindings.push({...binding, ...connection});
        }
    } else {
        bindings.push({inst: term, ...connection});
    }
}
