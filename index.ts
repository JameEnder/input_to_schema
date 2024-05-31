#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

import { type } from 'arktype';
import { program } from 'commander';
import ts from 'typescript';

const findSyntaxKind = (statement: ts.Node, kind: ts.SyntaxKind): ts.Node | undefined => {
    if (statement.kind === kind) {
        return statement;
    }

    return statement.getChildren().find((child) => findSyntaxKind(child, kind))
};

const JSDOC_PROPS_TO_EVAL = ["default", "prefill", "minimum", "maximum", "enumTitles", "schemaVersion", "required", "items", "example"]

function getJsDocFromNode(_checker: ts.TypeChecker, rawNode: ts.Node) {
    const output: Record<string, any> = {};

    // @ts-ignore
    const node = rawNode.getFullText ? rawNode : rawNode.valueDeclaration

    const jsDocRegex = new RegExp(/@(\w+)\s+((?:.*(?:\n(?!\s*\*\s*@|\s*\*\/).*)*))/mg)
 
    let matches;

    while ((matches = jsDocRegex.exec(node.getFullText().slice(0, node.getLeadingTriviaWidth()))) !== null) {
        const [, name, value, ] = matches

        output[name] = value.replace(/\n\t\s*\*/g, '')

        if (JSDOC_PROPS_TO_EVAL.includes(name)) {
            try {
                if (name === "items") {
                    output[name] = eval(JSON.parse(output[name]))
                } else {
                    output[name] = eval(output[name])
                }
            } catch (e) {
                console.error(name, "with value", JSON.stringify(output[name]), "couldnt be evaluated because", e)
                process.exit(1)
            }
        }
    }

    return output;
}

type IntegerSchema = {
    type: 'integer'
    default?: number
    prefill?: number
}

type StringSchema = {
    type: 'string'
    default?: string
    prefill?: string
}

type ObjectSchema = {
    type: 'object'
    default?: Object
    prefill?: Object
    properties: Record<string, SchemaProperty>
    required: string[]
}

type EnumSchema = {
    type: ObjectSchema['type'] | BooleanSchema['type'] | ArraySchema['type'] | StringSchema['type'] | IntegerSchema['type']
    enum: any[]
    enumTitles?: string[]
    default?: any
    prefill?: any
}

type BooleanSchema = {
    type: 'boolean'
    default?: boolean
    prefill?: boolean
}

type ArraySchema = {
    type: 'array'
    default?: any[]
    prefill?: any[]
}

type SchemaProperty = (
    | IntegerSchema
    | BooleanSchema
    | StringSchema
    | ObjectSchema
    | EnumSchema
    | ArraySchema
) & JSDocPropertyInfo

const JSDocPropertyInfoSchema = type({
    'title?': 'string',
    'description?': 'string',
    'editor?': 'string',
    'default?': 'string',
    'prefill?': 'string | string[]',
    'id?': 'string',
    'enumTitles?': 'string[]',
    'sectionCaption?': 'string',
    'sectionDescription?': 'string',
    'required?': 'string | string[]', 
    'uniqueItems?': 'any[]',
    'example?': 'any',
    'items?': 'object' 
});

type JSDocPropertyInfo = typeof JSDocPropertyInfoSchema.infer

function convertInputIntoSchema(
    checker: ts.TypeChecker,
    node: ts.Node,
): SchemaProperty {
    const type = checker.getTypeAtLocation(node);

    const schema = convertObjectToSchema(checker, type as ts.InterfaceType, {} as any, []);

    schema.editor = undefined;

    return {
        ...getJsDocFromNode(checker, node),
        ...schema
    };
}

function convertEnumlikeIntoEnum(_checker: ts.TypeChecker, enumlike: ts.EnumType) {
    // @ts-ignore
    return enumlike.types.map((type: ts.Type) => type.value);
}

function convertEnumlikeIntoSchema(
    checker: ts.TypeChecker,
    enumlike: ts.EnumType,
    doc: JSDocPropertyInfo,
): SchemaProperty {
    const schema = {
        // TODO: actual type inference
        type: 'string' as const,
        enum: convertEnumlikeIntoEnum(checker, enumlike),
        ...doc
    };

    return schema;
}

function convertJSDocToSchema(
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
): Omit<SchemaProperty, 'type'> {
    const jsDoc = symbol.getJsDocTags(checker);
    const collectedJsDoc: Record<string, string> = {};

    for (const tag of jsDoc) {
        if (tag.text) {
            collectedJsDoc[tag.name] = tag.text![0].text.replace(/"/g, '').trim();
        }
    }

    const validatedJsDoc = JSDocPropertyInfoSchema(collectedJsDoc);

    if (validatedJsDoc instanceof type.errors) {
        console.warn(validatedJsDoc.summary);
        process.exit(1);
    }

    if (!validatedJsDoc.description) validatedJsDoc.description = ""

    return validatedJsDoc;
}

function convertPrimitiveToSchema(
    _checker: ts.TypeChecker,
    type: ts.Type,
    doc: Omit<SchemaProperty, 'type'>,
): SchemaProperty {
    if (type.flags & ts.TypeFlags.String) {
        return {
            ...doc,
            type: 'string',
        };
    } if (type.flags & ts.TypeFlags.Number) {
        return {
            ...doc,
            type: 'integer',
        };
    } if (type.flags & ts.TypeFlags.Boolean) {
        return {
            ...doc,
            type: 'boolean',
        };
    }
    return {
        ...doc,
        type: 'string',
    };
}

function convertArrayToSchema(
    _checker: ts.TypeChecker,
    _array: ts.ObjectType,
    doc: Omit<SchemaProperty, 'type'>,
): SchemaProperty {
    return {
        type: 'array',
        ...doc,
        uniqueItems: doc.uniqueItems && eval(doc.uniqueItems as unknown as string)
    };
}

function convertObjectToSchema(
    checker: ts.TypeChecker,
    object: ts.ObjectType,
    doc: Omit<SchemaProperty, 'type'>,
    propertyPath: string[],
): SchemaProperty {
    if (checker.isArrayType(object)) return convertArrayToSchema(checker, object, doc);

    const schema: Record<string, SchemaProperty> = {};
    const required: string[] = [];

    const properties = object.getProperties();

    for (const property of properties) {
        // const propertyDoc = convertJSDocToSchema(checker, property);
        const propertyDoc = getJsDocFromNode(checker, property as unknown as ts.Node);

        const propertySchema = convertTypeToSchema(
            checker,
            checker.getTypeOfSymbol(property),
            propertyDoc,
            [...propertyPath, property.name],
        );


        if (
            // !(property.flags & ts.SymbolFlags.Optional) && propertySchema.default === undefined && propertySchema.editor !== 'hidden' && propertySchema.required
            propertySchema.required
        ) {
            required.push(property.name);
        }

        schema[property.name] = propertySchema;
    }

    return {
        type: 'object',
        properties: schema,
        ...doc,
        required,
    };
}

function convertTypeToSchema(
    checker: ts.TypeChecker,
    type: ts.Type,
    doc: Omit<SchemaProperty, 'type'>,
    propertyPath: string[],
): SchemaProperty {
    doc.description ??= "";

    if (
        type.flags & ts.TypeFlags.Enum
		|| type.flags & ts.TypeFlags.EnumLike
		|| type.flags & ts.TypeFlags.EnumLiteral
		|| (type.flags & ts.TypeFlags.Union && !(type.flags & ts.TypeFlags.Boolean))
    ) {
        return convertEnumlikeIntoSchema(checker, type as ts.EnumType, doc);
    }

    if (type.flags & ts.TypeFlags.Object) {
        return convertObjectToSchema(checker, type as ts.ObjectType, doc, propertyPath);
    }

    if (!(type.flags & ts.TypeFlags.NonPrimitive)) {
        return convertPrimitiveToSchema(checker, type as ts.Type, doc);
    }

    if ((type as any).intrinsicName === 'object') {
        return {
            ...doc,
            type: 'object'
        } as SchemaProperty
    }

    console.log(type)

    process.exit(1);
}

export function convertJsDoccableToString(value: SchemaProperty, required: boolean, level = 0) {
    const padding = '\t'.repeat(level);
    let output = '';
    output += `${padding}/**\n`;

    for (const [jsDoccableName, jsDoccableValue] of Object.entries(value)) {
        if (jsDoccableName === 'type') continue;
        if (jsDoccableName === 'enum') continue;
        if (jsDoccableName === 'properties') continue;
        if (jsDoccableName === 'description' && jsDoccableValue === '') continue;

        let formattedValue = jsDoccableValue;

        if (JSDOC_PROPS_TO_EVAL.includes(jsDoccableName)) {
            if (required && jsDoccableName === 'required') {
                formattedValue = ''
            } else if (!required && jsDoccableName === 'required') { 
                continue;
            } else if (value.type === 'string' && ["default", "prefill", "example"].includes(jsDoccableName)) {
                formattedValue = `"${formattedValue}"`
            } else {
                formattedValue = JSON.stringify(formattedValue)
            }
        }

        output += `${padding} * @${jsDoccableName} ${formattedValue}\n`;

    }

    if (required) {
        output += `${padding} * @required true\n`;
    }

    output += `${padding} */\n`;

    return output;
}

export function convertSchemaToType(name: string, schema: SchemaProperty, required = false, level = 0): string {
    const padding = '\t'.repeat(level);

    // @ts-ignore
    if (schema.type === 'integer') {
        // @ts-ignore
        schema.type = 'number';
    }

    // @ts-ignore
    if (schema.type === 'array') {
        if (schema.editor === 'stringList') {
            // @ts-ignore
            schema.type = 'string[]';
        } else {
            // @ts-ignore
            schema.type = 'any[]';
        }
    }

    if (schema.type === 'object' && schema.id) {
        let output = '';

        const jsDoccable: SchemaProperty = JSON.parse(JSON.stringify(schema));

        const { properties, required } = (schema as ObjectSchema);

        output += convertJsDoccableToString(jsDoccable, false, level)

        output += `type ${name} = {\n`;

        if (properties) {
            for (const [name, property] of Object.entries(properties)) {
                output += `${convertSchemaToType(name, property, required ? required.includes(name) : false, level + 1)}\n\n`;
            }
        }

        return `${output}}`;
    }

    let output = '';

    const jsDoccable: SchemaProperty = JSON.parse(JSON.stringify(schema));

    output += convertJsDoccableToString(jsDoccable, required, level)
    
    const requiredString = jsDoccable.default !== undefined ? '?' : '';

    // @ts-ignore
    if (jsDoccable?.enum) {
        // @ts-ignore
        output += `${padding}${name}${requiredString}: ${jsDoccable?.enum.map((each) => `'${each}'`).join(' | ')}`;
    } else {
        output += `${padding}${name}${requiredString}: ${schema.type}`;
    }

    return output;
}

function loadProgram(sourcePath: string, inputFileName: string): { program: ts.Program, sourceFile?: ts.SourceFile } {
    const files = fs.readdirSync(sourcePath).map((file) => path.join(sourcePath, file));
    const inputFilePath = files.find((file) => file.includes(inputFileName));

    if (!inputFilePath) {
        console.error(`Couldn't find any '${inputFileName}' file in '${sourcePath}'.`);
        process.exit(1);
    }

    const program = ts.createProgram(files, { baseUrl: sourcePath });

    const sourceFile = program.getSourceFile(inputFilePath);

    if (!sourceFile) {
        console.error("Couldn't load source program");
        process.exit(1);
    }

    return { program, sourceFile };
}

export function getSchemaFromSourcePath(sourcePath: string, inputFileName: string, typeName?: string) {
    const { program, sourceFile } = loadProgram(sourcePath, inputFileName);

    const checker = program.getTypeChecker();

    const { inputNode, inputDefaults } = getDefaultsFromInputAssign(checker, sourceFile!, typeName);

    if (!inputNode) {
        console.error(`No '${typeName}' type found in the supplied file.`);
        process.exit(1);
    }

    const schema = convertInputIntoSchema(checker, inputNode!);

    if (!inputDefaults) {
        // console.warn(`No defaults found for '${typeName}'`);
        return cleanUpSchema(schema);
    }

    return cleanUpSchema(schema);
}

export function getSchemaFromSourcePathMultiple(sourcePath: string, inputFileName: string, ignoreTypeName: string, pattern: RegExp) {
    const { program, sourceFile } = loadProgram(sourcePath, inputFileName);

    const checker = program.getTypeChecker();

    const { inputNodes } = getDefaultsFromInputAssignMultiple(checker, sourceFile!, ignoreTypeName, pattern);

    if (!inputNodes.length) {
        console.error(`No '${pattern}' type found in the supplied file.`);
        process.exit(1);
    }

    return inputNodes
        .map((inputNode) => convertInputIntoSchema(checker, inputNode))
        .map((schema) => cleanUpSchema(schema))
}

function getDefaultsFromInputAssign(_checker: ts.TypeChecker, sourceFile: ts.SourceFile, typeName?: string) {
    let inputNode: ts.Node | undefined;
    let inputDefaults: ts.BindingElement[] | undefined;

    for (const child of sourceFile.statements) {
        const resultVD = findSyntaxKind(child, ts.SyntaxKind.VariableDeclaration);

        if (!resultVD) continue;

        const { initializer } = (resultVD as ts.VariableDeclaration);

        if (!initializer) continue;

        // @ts-ignore
        if (initializer.name.escapedText !== typeName && initialized.name.escapedText !== typeName) continue;

        const defaults = findSyntaxKind(child, ts.SyntaxKind.ObjectBindingPattern);
        if (!defaults) continue;

        inputNode = initializer;
        inputDefaults = (defaults as ts.ObjectBindingPattern).elements.filter((element) => element.initializer);

        break;
    }

    if (!inputNode) {
        for (const child of sourceFile.statements) {
            let found = findSyntaxKind(child, ts.SyntaxKind.InterfaceDeclaration);

            if (!found) {
                found = findSyntaxKind(child, ts.SyntaxKind.TypeAliasDeclaration);
            }

            if (!found) continue;

            // @ts-ignore
            if (found.name.escapedText !== typeName) continue;

            if (found) {
                inputNode = found;
                break;
            }
        }
    }

    return { inputNode, inputDefaults };
}

function getDefaultsFromInputAssignMultiple(_checker: ts.TypeChecker, sourceFile: ts.SourceFile, ignoreTypeName: string, pattern: RegExp) {
    const alreadyProcessed: string[] = [];
    const inputNodes: ts.Node[] = [];

    for (const child of sourceFile.statements) {
        const refreshedPattern = new RegExp(pattern)

        let found = findSyntaxKind(child, ts.SyntaxKind.InterfaceDeclaration);

        if (!found) {
            found = findSyntaxKind(child, ts.SyntaxKind.TypeAliasDeclaration);
        }

        if (!found) continue;

        // @ts-ignore
        if (!refreshedPattern.test(found.name.escapedText) && !alreadyProcessed.includes(found.name.escapedText)) continue;

        // @ts-ignore
        if (found.name.escapedText === ignoreTypeName) continue;

        // @ts-ignore
        alreadyProcessed.push(found.name.escapedText)

        inputNodes.push(found);
    }

    return { inputNodes, inputDefaults: [] };
}



function cleanUpSchema(unorderedSchema: SchemaProperty) {
    const schema = new Map();

    schema.set('title', unorderedSchema.title);
    schema.set('type', unorderedSchema.type);
    schema.set('description', unorderedSchema.description);
    schema.set('editor', unorderedSchema.editor);

    for (const key of Object.keys(unorderedSchema)) {
        if (['title', 'type', 'editor', 'description'].includes(key)) continue;

        schema.set(key, unorderedSchema[key as keyof typeof unorderedSchema]);
    }

    if (schema.get('type') === 'object' && schema.get('properties')) {
        const properties = schema.get('properties');

        for (const name of Object.keys(properties)) {
            properties[name] = cleanUpSchema(properties[name])
        }
    }

    if (schema.get('type') !== 'object') {
        schema.delete('required');
    }

    for (const key of schema.keys()) {
        if (schema.get(key) === undefined) {
            schema.delete(key)
        }
    }

    return Object.fromEntries(schema);
}

program
    .command('type-to-json')
    .argument('<source>')
    .option('--typeName <name>', 'custom Input type name', 'Input')
    .option('--inputFileName <name>', 'name of the file containing Input definition', 'main.ts')
    .action((source: string, options: { typeName: string, inputFileName: string }) => {
        const schema = getSchemaFromSourcePath(source, options.inputFileName, options.typeName);

        console.log(schema)

        const json = JSON.stringify(schema, undefined, 4);

        console.log(json);
    });

program
    .command('multiactor-type-to-json')
    .argument('<source>')
    .option('--inputFile <inputFile>', 'Input file', 'input.ts')
    .option('--typeRegex <regex>', 'Input type regex', '.*Input')
    .option('--ignoreSpecificType <ignoredTypeName>', 'Input type to ignore', '')
    .option('--write <folder>', 'A folder to write the output to', '')
    .action((source: string, options: { inputFile: string, typeRegex: string, ignoreSpecificType: string, write: string }) => {
        const schemas = getSchemaFromSourcePathMultiple(source, options.inputFile, options.ignoreSpecificType, new RegExp(options.typeRegex))

        for (const schema of schemas) {
            if (options.write) {
                const inputSchemaPath = `${options.write}/${schema.id}`

                delete schema.id;

                if (!fs.existsSync(inputSchemaPath)) {
                    fs.mkdirSync(inputSchemaPath)
                }

                if (!fs.existsSync(`${inputSchemaPath}/.actor`)) {
                    fs.mkdirSync(`${inputSchemaPath}/.actor`)
                }

                fs.writeFileSync(`${inputSchemaPath}/.actor/INPUT_SCHEMA.json`, JSON.stringify(schema, null, 4), 'utf8');
            } else {
                console.log(JSON.stringify(schema, null, 4))
            }
        }
    });

program
    .command('json-to-type')
    .argument('<source>')
    .action((source: string) => {
        console.log(convertSchemaToType('Input', JSON.parse(fs.readFileSync(source, 'utf8'))));
    });

const camelize = (s: string) => {
    const camelized = s.replace(/-./g, (x) => x[1].toUpperCase()).split('');
    camelized[0] = camelized[0].toUpperCase();
    return camelized.join('');
};

export function multiActorJsonToTypes(actorsFolder: string): string[] {
        const actorsDirs = fs.readdirSync(actorsFolder);
        const schemas = [];

        for (const actorsDir of actorsDirs) {
            const files = fs.readdirSync(`${actorsFolder}/${actorsDir}/.actor/`);

            let schemaPath = files.find((file) => file.includes('INPUT_SCHEMA.json'));

            if (!schemaPath) {
                const actorFile = files.find((file) => file.includes('actor.json'));

                const actorInfo = JSON.parse(fs.readFileSync(`${actorsFolder}/${actorsDir}/.actor/${actorFile}`, 'utf8'));

                schemaPath = actorInfo.input;
            }


            schemas.push({
                name: camelize(actorsDir.split('/').slice(-1)[0]),
                id: actorsDir.split('/').slice(-1)[0],
                schema: JSON.parse(fs.readFileSync(`${actorsFolder}/${actorsDir}/.actor/${schemaPath}`, 'utf8')),
            });
        }

        const types = schemas
            .map(schema => convertSchemaToType(`${schema.name}Input`, {
                ...schema.schema as any,
                id: schema.id
            }))

        return types
}

program
    .command('multiactor-json-to-type')
    .argument('<actorsFolder>')
    .option('--write <file>')
    .action((actorsFolder: string, options: { write: string }) => {
        const inputTypesStrings = multiActorJsonToTypes(actorsFolder)

        if (options.write) {
            fs.writeFileSync(options.write, inputTypesStrings.join('\n'))
        } else {
            console.log(inputTypesStrings.join('\n'))
        }
    });

if (process.env.MODE !== 'test') {
    program.parse();
}
