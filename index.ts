import ts from 'typescript'
import * as arktype from 'arktype'
import * as fs from 'fs'
import * as path from 'path'
import { program } from 'commander';

const findSyntaxKind = (statement: ts.Node, kind: ts.SyntaxKind): ts.Node | undefined => {
	if (statement.kind === kind) {
		return statement;
	}

	for (const child of statement.getChildren()) {
		const found = findSyntaxKind(child, kind)

		if (found) return found
	}

	return undefined
}

type NumberSchema = {
	type: 'number'
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
	type: ObjectSchema["type"] | BooleanSchema["type"] | ArraySchema["type"] | StringSchema["type"] | NumberSchema["type"]
	editor: 'select'
	enum: any[]
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
	| NumberSchema
	| BooleanSchema
	| StringSchema
	| ObjectSchema
	| EnumSchema
	| ArraySchema
)

function convertInputIntoSchema(
	checker: ts.TypeChecker,
	node: ts.Node
): Omit<SchemaProperty, 'editor'> {
	const type = checker.getTypeAtLocation(node)

	const schema = convertObjectToSchema(checker, type as ts.InterfaceType, {} as any, [])

	//@ts-ignore
	delete schema['editor']

	return schema
}

function convertEnumlikeIntoEnum(checker: ts.TypeChecker, enumlike: ts.EnumType) {
	// @ts-ignore
	return enumlike.types.map((type: ts.Type) => type.value)
}

function convertEnumlikeIntoSchema(
	checker: ts.TypeChecker,
	enumlike: ts.EnumType,
	doc: Omit<SchemaProperty, 'type'>
): SchemaProperty {
	const schema = {
		// TODO: actual type inference
		type: 'string' as const,
		editor: 'select' as const,
		title: doc.title,
		description: doc.description,
		default: doc.default,
		prefill: doc.prefill,
		enum: convertEnumlikeIntoEnum(checker, enumlike),
	}

	return schema
}

function convertJSDocToSchema(
	checker: ts.TypeChecker,
	symbol: ts.Symbol
): Omit<SchemaProperty, 'type'> {
	const JSDocInfoValidator = arktype.type({
		'name?': 'string',
		'description?': 'string',
		'editor?': 'string',
		'default?': 'string',
		'prefill?': 'string',
	})

	const jsDoc = symbol.getJsDocTags(checker)
	const collectedJsDoc: Record<string, string> = {}

	for (const tag of jsDoc) {
		if (tag.text) {
			collectedJsDoc[tag.name] = tag.text![0].text.replace(/"/g, '')
		}
	}

	const { data: validatedJsDoc, problems } = JSDocInfoValidator(collectedJsDoc)

	if (problems) {
		console.warn(problems)
	}

	return {
		title: validatedJsDoc?.name || '',
		description: validatedJsDoc?.description || '',
		editor: (validatedJsDoc?.editor as any) || 'textfield',
		default: validatedJsDoc?.default,
		prefill: validatedJsDoc?.prefill,
	}
}

function convertPrimitiveToSchema(
	checker: ts.TypeChecker,
	type: ts.Type,
	doc: Omit<SchemaProperty, 'type'>
): SchemaProperty {
	if (type.flags & ts.TypeFlags.String) {
		return {
			...doc,
			type: 'string',
			editor: 'textfield',
			default: doc.default && String(doc.default),
			prefill: doc.prefill && String(doc.prefill),
		}
	} else if (type.flags & ts.TypeFlags.Number) {
		return {
			...doc,
			type: 'number',
			editor: 'number',
			default: doc.default && parseFloat(doc.default),
			prefill: doc.prefill && parseFloat(doc.prefill),
		}
	} else if (type.flags & ts.TypeFlags.Boolean) {
		return {
			...doc,
			type: 'boolean',
			editor: 'checkmark',
			default: doc.default && Boolean(doc.default),
			prefill: doc.prefill && Boolean(doc.prefill),
		}
	} else {
		return {
			...doc,
			type: 'string',
			editor: 'textfield',
		}
	}
}

function convertArrayToSchema(
	checker: ts.TypeChecker,
	array: ts.ObjectType,
	doc: Omit<SchemaProperty, 'type'>
): SchemaProperty {
	doc.default = doc.default && JSON.parse(doc.default.replace(/'/g, '"'))

	return {
		...doc,
		type: 'array',
		editor: 'textfield',
	}
}

function convertObjectToSchema(
	checker: ts.TypeChecker,
	object: ts.ObjectType,
	doc: Omit<SchemaProperty, 'type'>,
	propertyPath: string[]
): SchemaProperty {
	if (checker.isArrayType(object)) return convertArrayToSchema(checker, object, doc)

	const schema: Record<string, SchemaProperty> = {}
	const required: string[] = []

	const properties = object.getProperties()

	for (const property of properties) {
		const propertyDoc = convertJSDocToSchema(checker, property)

		const propertySchema = convertTypeToSchema(
			checker,
			checker.getTypeOfSymbol(property),
			propertyDoc,
			[...propertyPath, property.name]
		)

		if (
			!(property.flags & ts.SymbolFlags.Optional) && propertySchema.default === undefined
		) {
			required.push(property.name)
		}

		schema[property.name] = propertySchema
	}

	doc.default =
		doc.default &&
		JSON.parse(
			doc.default
				.replace(/(?:['"])?([a-z0-9A-Z_]+)(?:['"])?:/g, '"$1": ')
				.replace(/:\s*?(?:'([^']*)')/g, ': "$1"')
				.replace(/\s*"[^"]*":\s*[^(,[\]{}]*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*,?/g, '')
		)

	return {
		...doc,
		type: 'object',
		editor: 'textfield',
		properties: schema,
		required,
	}
}

function convertTypeToSchema(
	checker: ts.TypeChecker,
	type: ts.Type,
	doc: Omit<SchemaProperty, 'type'>,
	propertyPath: string[]
): SchemaProperty {
	if (
		type.flags & ts.TypeFlags.Enum ||
		type.flags & ts.TypeFlags.EnumLike ||
		type.flags & ts.TypeFlags.EnumLiteral ||
		(type.flags & ts.TypeFlags.Union && !(type.flags & ts.TypeFlags.Boolean))
	) {
		return convertEnumlikeIntoSchema(checker, type as ts.EnumType, doc)
	}

	if (type.flags & ts.TypeFlags.Object) {
		return convertObjectToSchema(checker, type as ts.ObjectType, doc, propertyPath)
	}

	if (!(type.flags & ts.TypeFlags.NonPrimitive)) {
		return convertPrimitiveToSchema(checker, type as ts.Type, doc)
	}

	process.exit(1)
}

function loadProgram(sourcePath: string): { program: ts.Program, sourceFile: ts.SourceFile } {
	const files = fs.readdirSync(sourcePath).map((file) => path.join(sourcePath, file))
	const mainFilePath = files.find((file) => file.includes('main'))

	if (!mainFilePath) {
		console.error(`Couldn't find any main.ts file in '${sourcePath}'.`)
		process.exit(1)
	}

	const program = ts.createProgram(files, { baseUrl: sourcePath })

	const sourceFile = program.getSourceFile(mainFilePath)

	if (!sourceFile) {
		console.error("Couldn't load source program")
		process.exit(1)
	}

	return { program, sourceFile };
}

function getSchemaFromSourcePath(sourcePath: string, typeName?: string) {
	const { program, sourceFile } = loadProgram(sourcePath);

	const checker = program.getTypeChecker()

	const { inputType, inputDefaults } = getDefaultsFromInputAssign(checker, sourceFile, typeName);

	const inputNode = inputType?.symbol?.declarations?.[0]

	if (!inputNode) {
		console.error(`No '${typeName}' type found in the supplied file.`);
		process.exit(1);
	}

	const schema = convertInputIntoSchema(checker, inputNode!)

	if (!inputDefaults) {
		console.warn(`No defaults found for '${typeName}'`);
		return;
	}

	const objectSchema = (schema as any as ObjectSchema)
	for (const d of inputDefaults) {
		const property = objectSchema.properties[d.name.getText()]

		// This will surely not be a concern *clueless*
		property.default = eval(d.initializer?.getText()!);
		
		objectSchema.required = objectSchema.required.filter(p => p != d.name.getText())
	}


	return schema;
}

function getDefaultsFromInputAssign(checker: ts.TypeChecker, sourceFile: ts.SourceFile, typeName?: string) {
	let inputType: ts.Type | undefined;
	let inputDefaults: ts.BindingElement[] | undefined;
	
	for (const child of sourceFile.statements) {
		const resultVD = findSyntaxKind(child, ts.SyntaxKind.VariableDeclaration);

		if (!resultVD) continue
		
		const initializer = (resultVD as ts.VariableDeclaration).initializer

		if (!initializer) continue

		const type = checker.getTypeAtLocation(initializer);

		if (type.aliasSymbol?.getName() !== typeName && type.symbol.escapedName !== typeName) continue;
		
		const defaults = findSyntaxKind(child, ts.SyntaxKind.ObjectBindingPattern);
		if (!defaults) continue;
	
		inputType = type
		inputDefaults = (defaults as ts.ObjectBindingPattern).elements.filter(element => element.initializer);
	
		break;
	}

	return { inputType, inputDefaults }
	
}

program
	.command("print")
	.argument("<source>")
	.option('--typeName <name>', 'custom Input type name', 'Input')
	.action((source, options) => {
		const schema = getSchemaFromSourcePath(source, options.typeName)

		const json = JSON.stringify(schema, undefined, 4)

		console.log(json)
	})

program.parse()


