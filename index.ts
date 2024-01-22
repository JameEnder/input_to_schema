import ts from 'typescript'
import * as arktype from 'arktype'
import * as fs from 'fs'
import * as path from 'path'
import lesy from '@lesy/compiler'

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
	type: 'enum'
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

// function convertUnionIntoEnum(checker: ts.TypeChecker, union: ts.UnionType) {
// 	return union.types.map((type) => checker.typeToString(type).replace(/"/g, ''))
// }

function convertEnumlikeIntoEnum(checker: ts.TypeChecker, enumlike: ts.EnumType) {
	// @ts-ignore
	return enumlike.types.map((type: ts.Type) => type.value)
}

function convertEnumlikeIntoSchema(
	checker: ts.TypeChecker,
	enumlike: ts.EnumType,
	doc: Omit<SchemaProperty, 'type'>
): SchemaProperty {
	return {
		type: 'enum',
		editor: 'select',
		title: doc.title,
		description: doc.description,
		default: doc.default,
		prefill: doc.prefill,
		enum: convertEnumlikeIntoEnum(checker, enumlike),
	}
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
		collectedJsDoc[tag.name] = tag.text![0].text.replace(/"/g, '')
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

function convertArrayToSchema(checker: ts.TypeChecker,
	array: ts.ObjectType,
	doc: Omit<SchemaProperty, 'type'>,
): SchemaProperty {
	doc.default = doc.default && JSON.parse(
		doc.default
			.replace(/'/g, "\"")
	)

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

		if (property.name === "urlsDefault") {
			
			// @ts-ignore
			console.log(checker.getTypeOfSymbol(property))
		}

		const propertySchema = convertTypeToSchema(checker, checker.getTypeOfSymbol(property), propertyDoc, [...propertyPath, property.name])

		if (property.flags & ts.SymbolFlags.Optional || propertySchema.default === undefined) {
			required.push(property.name)
		}

		schema[property.name] = propertySchema
	}

	doc.default = doc.default && JSON.parse(
		doc.default
			.replace(/(?:['"])?([a-z0-9A-Z_]+)(?:['"])?:/g, '"$1": ')
			.replace(/:\s*?(?:'([^']*)')/g, ': "$1"')
			.replace(
				/\s*"[^"]*":\s*[^(,[\]{}]*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*,?/g,
				''
			)
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

function getSchemaFromSourcePath(sourcePath: string) {
	const files = fs.readdirSync(sourcePath).map((file) => path.join(sourcePath, file))
	const mainFilePath = files.find((file) => file.includes('main'))

	if (!mainFilePath) {
		console.error("Couldn't find any main.ts file.")
		process.exit(1)
	}

	const program = ts.createProgram(files, { baseUrl: sourcePath })

	const sourceFile = program.getSourceFile(mainFilePath)

	if (!sourceFile) {
		console.error("Couldn't load source program")
		process.exit(1)
	}

	const checker = program.getTypeChecker()

	let inputSymbol: ts.Symbol | undefined

	for (const statement of sourceFile.statements) {
		statement.forEachChild((node) => {
			const actualNode = checker.getSymbolAtLocation(node)
			if (
				actualNode?.name === 'Input' &&
				actualNode.declarations &&
				actualNode.declarations.length > 0
			) {
				inputSymbol = actualNode
			}
		})

		if (inputSymbol) break
	}

	if (!inputSymbol) {
		console.error("No 'Input' interface found in the supplied file.")
		process.exit(1)
	}

	if (!inputSymbol.declarations || inputSymbol.declarations.length == 0) {
		console.error("No 'Input' interface definition found in the supplied file.")
		process.exit(1)
	}

	const inputNode = inputSymbol.declarations[0]

	return convertInputIntoSchema(checker, inputNode)
}

const PrintCommand = {
	name: 'print',
	description: 'Print the Input schema to terminal',
	args: { source: { type: 'string', required: true } },

	run: (ctx: any) => {
		const schema = getSchemaFromSourcePath(ctx.args.source)

		const json = JSON.stringify(schema, undefined, 4)

		console.log(json)
	},
}

const commands = [PrintCommand]

// @ts-ignore
lesy({ commands }).parse()
