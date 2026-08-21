import { describe, expect, it } from 'vitest';

import * as Rdf from '../../../src/data/rdf/rdfModel';
import { owl } from '../../../src/data/rdf/vocabulary';
import {
    ENCODED_PREFIX, decodeId, encodeId, isEncodedBlank, lookup as lookupFromBlank,
} from '../../../src/data/sparql/blankNodes';
import { BlankBinding } from '../../../src/data/sparql/sparqlModels';
import { OwlStatsSettings } from '../../../src/data/sparql/sparqlDataProviderSettings';

import { makeSparqlDataProvider, org, rdfs } from '../../mock/sparqlMocks';

const factory = Rdf.DefaultDataFactory;

const rdfsRange = `${rdfs.$namespace}range`;
const owlRestriction = `${owl.$namespace}Restriction`;
const owlOnProperty = `${owl.$namespace}onProperty`;
const xsdInteger = 'http://www.w3.org/2001/XMLSchema#integer';

function makeBinding(
    target: Rdf.NamedNode | Rdf.BlankNode | Rdf.Literal,
    overrides: Partial<BlankBinding> = {}
): BlankBinding {
    return {
        inst: factory.blankNode('b0'),
        blankType: factory.literal('blankNode'),
        blankSrc: factory.namedNode(`${org.$namespace}reportsTo`),
        blankSrcProp: factory.namedNode(rdfs.domain),
        blankTrgProp: factory.namedNode(owlOnProperty),
        blankTrg: target,
        ...overrides,
    };
}

describe('SPARQL blank node IRI codec', () => {
    it('round-trips the statements which describe a blank node', () => {
        const bindings = [
            makeBinding(factory.namedNode(org.hasUnit)),
            makeBinding(factory.literal('some text', 'en'), {
                blankTrgProp: factory.namedNode(rdfs.comment),
            }),
        ];

        const id = encodeId(bindings);
        expect(isEncodedBlank(id)).toBe(true);
        expect(id.startsWith(ENCODED_PREFIX)).toBe(true);

        const decoded = decodeId(id, factory);
        expect(decoded).toBeDefined();
        expect(decoded).toHaveLength(2);

        for (const binding of decoded!) {
            // the instance is restored as the encoded IRI itself
            expect(binding.inst.termType).toBe('NamedNode');
            expect(binding.inst.value).toBe(id);
            expect(binding.blankSrc?.value).toBe(`${org.$namespace}reportsTo`);
            expect(binding.blankSrcProp?.value).toBe(rdfs.domain);
        }

        const targets = decoded!.map(binding => binding.blankTrg);
        expect(targets).toContainEqual(factory.namedNode(org.hasUnit));
        expect(targets).toContainEqual(factory.literal('some text', 'en'));
    });

    it('produces the same IRI regardless of statement order or duplicates', () => {
        const first = makeBinding(factory.namedNode(org.hasUnit));
        const second = makeBinding(factory.namedNode(org.memberOf));

        expect(encodeId([first, second])).toBe(encodeId([second, first]));
        expect(encodeId([first, second, first])).toBe(encodeId([first, second]));
    });

    it('ignores the blank node label, which is local to a single response', () => {
        const fromOneResponse = makeBinding(factory.namedNode(org.hasUnit), {
            inst: factory.blankNode('b0'),
        });
        const fromAnother = makeBinding(factory.namedNode(org.hasUnit), {
            inst: factory.blankNode('genid-1234'),
        });

        expect(encodeId([fromOneResponse])).toBe(encodeId([fromAnother]));
    });

    it('distinguishes blank nodes by the statement which points at them', () => {
        const asDomain = makeBinding(factory.namedNode(org.hasUnit));
        const asRange = makeBinding(factory.namedNode(org.hasUnit), {
            blankSrcProp: factory.namedNode(rdfsRange),
        });

        expect(encodeId([asDomain])).not.toBe(encodeId([asRange]));
    });

    it('preserves the language tag and the datatype of a literal', () => {
        const tagged = decodeId(
            encodeId([makeBinding(factory.literal('etichetta', 'it'))]),
            factory
        );
        expect(tagged![0].blankTrg).toEqual(factory.literal('etichetta', 'it'));

        const typed = decodeId(
            encodeId([makeBinding(
                factory.literal('42', factory.namedNode(xsdInteger))
            )]),
            factory
        );
        expect(typed![0].blankTrg).toEqual(
            factory.literal('42', factory.namedNode(xsdInteger))
        );
    });

    it('labels an RDF list head as such and an untyped blank node as anonymous', () => {
        const listHead = decodeId(
            encodeId([makeBinding(factory.namedNode(org.Organization), {
                blankType: factory.literal('listHead'),
            })]),
            factory
        );
        expect(listHead![0].label?.value).toBe('RDFList');

        const typed = decodeId(
            encodeId([makeBinding(factory.namedNode(org.Organization), {
                class: factory.namedNode(owlRestriction),
            })]),
            factory
        );
        expect(typed![0].label?.value).toBe('Restriction');

        const untyped = decodeId(
            encodeId([makeBinding(factory.namedNode(org.Organization))]),
            factory
        );
        expect(untyped![0].label?.value).toBe('anonymous');
    });

    it('caps the encoded statements at blankNodeStatementLimit', () => {
        const bindings = Array.from({length: 100}, (_, i) => makeBinding(
            factory.namedNode(`http://example.org/ontology/Member${i}`)
        ));

        const uncapped = encodeId(bindings);
        const capped = encodeId(bindings, 5);

        expect(decodeId(uncapped, factory)).toHaveLength(100);
        expect(decodeId(capped, factory)).toHaveLength(5);
        expect(capped.length).toBeLessThan(uncapped.length / 10);

        // the cap keeps the IRI stable: same statements in any order, same IRI
        const shuffled = [...bindings].reverse();
        expect(encodeId(shuffled, 5)).toBe(capped);
    });

    it('rejects an IRI which is not an encoded blank node', () => {
        expect(decodeId(org.Organization, factory)).toBeUndefined();
        expect(decodeId(`${ENCODED_PREFIX}not-json`, factory)).toBeUndefined();
        expect(decodeId(`${ENCODED_PREFIX}eyJ0IjoieCJ9`, factory)).toBeUndefined();
    });
});

describe('SparqlDataProvider with acceptBlankNodes', () => {
    const settings = {...OwlStatsSettings, acceptBlankNodes: true};
    const reportsTo = `${org.$namespace}reportsTo`;

    it('does not surface blank nodes when the option is off', async () => {
        const provider = await makeSparqlDataProvider({}, OwlStatsSettings);
        const found = await provider.lookup({refElementId: reportsTo});
        expect(found.some(item => isEncodedBlank(item.element.id))).toBe(false);
    });

    it('surfaces a blank node as an element with an encoded IRI', async () => {
        const provider = await makeSparqlDataProvider({}, settings);
        const found = await provider.lookup({refElementId: reportsTo});

        const blanks = found.filter(item => isEncodedBlank(item.element.id));
        expect(blanks.length).toBeGreaterThan(0);

        // `rdfs:domain [a owl:Class; owl:unionOf (foaf:Agent org:Post)]` in the ontology
        const decoded = decodeId(blanks[0].element.id, factory);
        expect(decoded).toBeDefined();
        expect(decoded!.every(binding => binding.blankSrc?.value === reportsTo)).toBe(true);
    });

    it('answers elements() for a blank node by decoding its IRI', async () => {
        const provider = await makeSparqlDataProvider({}, settings);
        const found = await provider.lookup({refElementId: reportsTo});
        const blankIri = found.find(item => isEncodedBlank(item.element.id))!.element.id;

        const elements = await provider.elements({elementIds: [blankIri]});
        const element = elements.get(blankIri);
        expect(element).toBeDefined();
        expect(element!.id).toBe(blankIri);
        expect(element!.types).toContain(owl.Class);
    });

    it('answers connectedLinkStats() for a blank node by decoding its IRI', async () => {
        const provider = await makeSparqlDataProvider({}, settings);
        const found = await provider.lookup({refElementId: reportsTo});
        const blankIri = found.find(item => isEncodedBlank(item.element.id))!.element.id;

        const stats = await provider.connectedLinkStats({elementId: blankIri});
        expect(stats.length).toBeGreaterThan(0);
        const incoming = stats.find(stat => stat.id === rdfs.domain || stat.id === rdfsRange);
        expect(incoming?.inCount).toBeGreaterThan(0);
    });

    it('fills in the data of an entity reached by navigating from a blank node', async () => {
        const provider = await makeSparqlDataProvider({}, settings);
        const found = await provider.lookup({refElementId: reportsTo});
        const blankIri = found
            .map(item => item.element.id)
            .filter(isEncodedBlank)
            .find(id => decodeId(id, factory)!.some(
                binding => binding.blankSrcProp?.value === rdfs.domain
            ))!;
        expect(blankIri).toBeDefined();

        const fromBlank = await provider.lookup({
            refElementId: blankIri,
            refElementLinkId: rdfs.domain,
            linkDirection: 'in',
        });

        // the only statement pointing at this blank node is `org:reportsTo rdfs:domain [...]`
        const back = fromBlank.find(item => item.element.id === reportsTo);
        expect(back).toBeDefined();
        // the decoded IRI knows only the neighbour's IRI, the rest comes from the endpoint
        expect(back!.element.properties[rdfs.label]?.length).toBeGreaterThan(0);

        // the decoded bindings describe the connection the same way the endpoint does,
        // which is what `getFilteredData()` reads to classify a link as incoming
        const decoded = lookupFromBlank({
            refElementId: blankIri,
            refElementLinkId: rdfs.domain,
            linkDirection: 'in',
        }, factory);
        expect(decoded!.results.bindings).toContainEqual(expect.objectContaining({
            inst: factory.namedNode(reportsTo),
            link: factory.namedNode(rdfs.domain),
            direction: factory.literal('in'),
        }));
    });

    it('links a blank node back to the entity which points at it', async () => {
        const provider = await makeSparqlDataProvider({}, settings);
        const found = await provider.lookup({refElementId: reportsTo});
        const blankIri = found.find(item => isEncodedBlank(item.element.id))!.element.id;

        const links = await provider.links({
            primary: [reportsTo],
            secondary: [blankIri],
        });
        expect(links.some(link =>
            link.sourceId === reportsTo && link.targetId === blankIri
        )).toBe(true);
    });
});
