import fs from 'fs';
import path from 'path';

import * as arktype from 'arktype';
import { program } from 'commander';
import ts from 'typescript';

const findSyntaxKind = (statement: ts.Node, kind: ts.SyntaxKind): ts.Node | undefined => {
    if (statement.kind === kind) {
        return statement;
    }

    for (const child of statement.getChildren()) {
        const found = findSyntaxKind(child, kind);

        if (found) return found;
    }

    return undefined;
};

const JSDOC_PROPS_TO_EVAL = ["default", "prefill", "minimum", "maximum", "enumTitles", "schemaVersion"]

function getJsDocFromNode(checker: ts.TypeChecker, rawNode: ts.Node) {
    const output: Record<string, any> = {};

    const node = rawNode.getFullText ? rawNode : rawNode.valueDeclaration

    const jsDocRegex = new RegExp(/@(\w+)\s+((?:.*(?:\n(?!\s*\*\s*@|\s*\*\/).*)*))/mg)
 
    let matches;

    while ((matches = jsDocRegex.exec(node.getFullText().slice(0, node.getLeadingTriviaWidth()))) !== null) {
        const [, name, value, ] = matches

        output[name] = value.replace(/\n\t\s*\*/g, '')

        if (JSDOC_PROPS_TO_EVAL.includes(name)) {
            try {
                output[name] = eval(output[name])
            } catch (e) {
                console.error(name, "with value", JSON.stringify(output[name]), "couldnt be evaluated because", e)
                // process.exit(1)
            }
        }
    }

    return output;
}

type IntegerSchema = {
    type: 'integer'
    editor: 'number'
    default?: number
    prefill?: number
}

type StringSchema = {
    type: 'string'
    editor: 'textfield'
    default?: string
    prefill?: string
}

type ObjectSchema = {
    type: 'object'
    editor: 'textfield'
    default?: Object
    prefill?: Object
    properties: Record<string, SchemaProperty>
    required: string[]
}

type EnumSchema = {
    type: ObjectSchema['type'] | BooleanSchema['type'] | ArraySchema['type'] | StringSchema['type'] | IntegerSchema['type']
    editor: 'select' | 'stringList'
    enum: any[]
    enumTitles?: string[]
    default?: any
    prefill?: any
}

type BooleanSchema = {
    type: 'boolean'
    editor: 'checkmark'
    default?: boolean
    prefill?: boolean
}

type ArraySchema = {
    type: 'array'
    editor: 'textfield'
    default?: any[]
    prefill?: any[]
}

type SchemaProperty = { title: string; description: string } & (
    | IntegerSchema
    | BooleanSchema
    | StringSchema
    | ObjectSchema
    | EnumSchema
    | ArraySchema
)

function convertInputIntoSchema(
    checker: ts.TypeChecker,
    node: ts.Node,
): Omit<SchemaProperty, 'editor'> {
    const type = checker.getTypeAtLocation(node);

    const schema = convertObjectToSchema(checker, type as ts.InterfaceType, {} as any, []);

    // @ts-ignore
    delete schema.editor;

    return {
        ...getJsDocFromNode(checker, node),
        ...schema
    };
}

function convertEnumlikeIntoEnum(checker: ts.TypeChecker, enumlike: ts.EnumType) {
    // @ts-ignore
    return enumlike.types.map((type: ts.Type) => type.value);
}

function convertEnumlikeIntoSchema(
    checker: ts.TypeChecker,
    enumlike: ts.EnumType,
    doc: Omit<SchemaProperty, 'type'>,
): SchemaProperty {
    const schema = {
        // TODO: actual type inference
        type: 'string' as const,
        editor: 'select' as const,
        enum: convertEnumlikeIntoEnum(checker, enumlike),
        ...doc
    };

    return schema;
}

function convertJSDocToSchema(
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
): Omit<SchemaProperty, 'type'> {
    const JSDocInfoValidator = arktype.type({
        'title?': 'string',
        'description?': 'string',
        'editor?': 'string',
        'default?': 'string',
        'prefill?': 'string | string[]',
        'enumTitles?': 'string[]',
        'sectionCaption?': 'string',
        'sectionDescription?': 'string'
    });

    const jsDoc = symbol.getJsDocTags(checker);
    const collectedJsDoc: Record<string, string> = {};

    for (const tag of jsDoc) {
        if (tag.text) {
            collectedJsDoc[tag.name] = tag.text![0].text.replace(/"/g, '').trim();
        }
    }

    const { data: validatedJsDoc, problems } = JSDocInfoValidator(collectedJsDoc);

    if (problems) {
        console.warn(problems);
    }

    return {
        ...validatedJsDoc,
    };
}

function convertPrimitiveToSchema(
    checker: ts.TypeChecker,
    type: ts.Type,
    doc: Omit<SchemaProperty, 'type'>,
): SchemaProperty {
    if (type.flags & ts.TypeFlags.String) {
        return {
            ...doc,
            type: 'string',
            editor: doc.editor || 'textfield',
        };
    } if (type.flags & ts.TypeFlags.Number) {
        return {
            ...doc,
            type: 'integer',
            editor: doc.editor || 'number',
        };
    } if (type.flags & ts.TypeFlags.Boolean) {
        return {
            ...doc,
            type: 'boolean',
            editor: doc.editor || 'checkmark',
        };
    }
    return {
        ...doc,
        type: 'string',
        editor: doc.editor || 'textfield',
    };
}

function convertArrayToSchema(
    checker: ts.TypeChecker,
    array: ts.ObjectType,
    doc: Omit<SchemaProperty, 'type'>,
): SchemaProperty {
    return {
        type: 'array',
        editor: 'textfield',
        ...doc,
        uniqueItems: doc.uniqueItems && eval(doc.uniqueItems)
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
        const propertyDoc = getJsDocFromNode(checker, property);

        const propertySchema = convertTypeToSchema(
            checker,
            checker.getTypeOfSymbol(property),
            propertyDoc,
            [...propertyPath, property.name],
        );


        if (
            !(property.flags & ts.SymbolFlags.Optional) && propertySchema.default === undefined && propertySchema.editor !== 'hidden' && propertySchema.required
        ) {
            required.push(property.name);
        }

        schema[property.name] = propertySchema;
    }

    return {
        type: 'object',
        editor: 'textfield',
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

    process.exit(1);
}

export function convertJsDoccableToString(value: SchemaProperty, level: number = 0) {
    const padding = '\t'.repeat(level);
        let output = '';
        output += `${padding}/**\n`;

        for (const [jsDoccableName, jsDoccableValue] of Object.entries(value)) {
            if (jsDoccableName === 'type') continue;
            if (jsDoccableName === 'enum') continue;
            if (jsDoccableName === 'required') continue;
            if (jsDoccableName === 'properties') continue;
            if (jsDoccableValue === '') continue;

            let formattedValue = jsDoccableValue;

            if (JSDOC_PROPS_TO_EVAL.includes(jsDoccableName)) {
                if (value.type === 'string' && ["default", "prefill"].includes(jsDoccableName)) {
                    formattedValue = `"${formattedValue}"`
                } else {
                    formattedValue = JSON.stringify(formattedValue)
                }
            }

            output += `${padding} * @${jsDoccableName} ${formattedValue}\n`;
        }

        output += `${padding} */\n`;

    return output;
}

export function convertSchemaToType(name: string, schema: SchemaProperty, level: number = 0): string {
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

    if (schema.type === 'object') {
        let output = '';

        const jsDoccable: SchemaProperty = JSON.parse(JSON.stringify(schema));

        output += convertJsDoccableToString(jsDoccable, level)

        output += `type ${name} = {\n`;

        const { properties } = (schema as ObjectSchema);

        for (const [name, property] of Object.entries(properties)) {
            output += `${convertSchemaToType(name, property, level + 1)}\n\n`;
        }

        return `${output}}`;
    }

    let output = '';

    const jsDoccable: SchemaProperty = JSON.parse(JSON.stringify(schema));

    output += convertJsDoccableToString(jsDoccable, level)
    
    const required = jsDoccable.default !== undefined ? '?' : '';

    // @ts-ignore
    if (jsDoccable?.enum) {
        // @ts-ignore
        output += `${padding}${name}${required}: ${jsDoccable?.enum.map((each) => `'${each}'`).join(' | ')}`;
    } else {
        output += `${padding}${name}${required}: ${schema.type}`;
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

    const { inputNode, inputDefaults } = getDefaultsFromInputAssign(checker, sourceFile, typeName);

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

function getDefaultsFromInputAssign(checker: ts.TypeChecker, sourceFile: ts.SourceFile, typeName?: string) {
    let inputNode: ts.Node | undefined;
    let inputDefaults: ts.BindingElement[] | undefined;

    for (const child of sourceFile.statements) {
        const resultVD = findSyntaxKind(child, ts.SyntaxKind.VariableDeclaration);

        if (!resultVD) continue;

        const { initializer } = (resultVD as ts.VariableDeclaration);

        if (!initializer) continue;

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

            if (found.name.escapedText !== typeName) continue;

            if (found) {
                inputNode = found;
                break;
            }
        }
    }

    return { inputNode, inputDefaults };
}

function cleanUpSchema(schema: SchemaProperty) {
    if (schema.type === 'object') {
        const properties = (schema as ObjectSchema).properties
        for (const name in properties) {
            cleanUpSchema(properties[name])
        }
    }

    for (const key in schema) {
        if (schema[key as keyof typeof schema] === undefined) delete schema[key as keyof typeof schema]
    }

    return schema;
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
    .action((source, options: { inputFile: string, typeRegex: string }) => {

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

program
    .command('multiactor-json-to-type')
    .argument('<actorsFolder>')
    .action((actorsFolder: string) => {
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
                schema: JSON.parse(fs.readFileSync(`${actorsFolder}/${actorsDir}/.actor/${schemaPath}`, 'utf8')),
            });
        }

        for (const schema of schemas) {
            console.log(convertSchemaToType(`${schema.name}Input`, schema.schema as any));
        }
    });

if (process.env.MODE !== 'test') {
    program.parse();
}
