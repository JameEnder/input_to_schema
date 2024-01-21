#!/usr/bin/env node

import ts, { TypeFlags } from 'typescript'
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
} & Schema

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

type SchemaProperty = { title: string; description: string; required: boolean } & (
	| NumberSchema
	| BooleanSchema
	| StringSchema
	| ObjectSchema
	| EnumSchema
)

type Schema = {
	properties: Record<string, Omit<SchemaProperty, 'required'>>
	required: string[]
}

function omit<T extends Object, const Keys extends string[]>(
	object: T,
	keys: Keys
): Omit<T, (typeof keys)[number]> {
	const omited = JSON.parse(JSON.stringify(object))

	for (const key of keys) {
		delete omited[key]
	}

	return omited
}

function convertSchemaPropertiesToSchema(properties: Record<string, SchemaProperty>): Schema {
	const required = Object.entries(properties)
		.filter(([_, value]) => value.required)
		.map(([key, _]) => key)

	const omitedProperties: Record<string, Omit<SchemaProperty, 'required'>> = {}

	for (const key in properties) {
		const property = properties[key]

		if (property.type == 'object') {
			const schema = convertSchemaPropertiesToSchema(property.properties as any)

			;(property as ObjectSchema).properties = schema.properties
			;(property as ObjectSchema).required = schema.required
			omitedProperties[key] = property
		} else {
			omitedProperties[key] = omit(property, ['required'])
		}
	}

	return { properties: omitedProperties, required }
}

function convertInputIntoSchema(checker: ts.TypeChecker, node: ts.Node): Schema {
	const type = checker.getTypeAtLocation(node)

	const properties = convertObjectToSchema(checker, type as ts.InterfaceType, [])
	const schema = convertSchemaPropertiesToSchema(properties)

	return schema
}

function convertUnionIntoEnum(checker: ts.TypeChecker, union: ts.UnionType) {
	return union.types.map((type) => checker.typeToString(type).replace(/"/g, ''))
}

function convertEnumlikeIntoEnum(checker: ts.TypeChecker, enumlike: ts.EnumType) {
	// @ts-ignore
	return enumlike.types.map((type: ts.Type) => type.value)
}


function convertObjectToSchema(checker: ts.TypeChecker, type: ts.Type, interfacePath: string[]) {
	const JSDocInfoValidator = arktype.type({
		'name?': 'string',
		'description?': 'string',
		'editor?': 'string',
		'default?': 'string',
		'prefill?': 'string',
	})

	type JSDocInfoSchema = typeof JSDocInfoValidator.infer

	const EDITOR_TYPE_MAP = {
		string: 'textfield',
		number: 'number',
		object: 'textfield',
		enum: 'select',
		boolean: 'checkmark',
	} as const

	const properties = type.getApparentProperties()
	const schema: Record<string, SchemaProperty> = {}

	for (const property of properties) {
		const propertySchema: SchemaProperty = {} as SchemaProperty
		const propertyPath = [...interfacePath, property.name].join('.')

		const jsDoc = property.getJsDocTags(checker)
		const collectedJsDoc: Record<string, string> = {}

		for (const tag of jsDoc) {
			collectedJsDoc[tag.name] = tag.text![0].text.replace(/"/g, '')
		}

		const { data: validatedJsDoc, problems } = JSDocInfoValidator(collectedJsDoc)

		if (problems) {
			console.warn(problems)
		}

		if (validatedJsDoc) {
			propertySchema.title = validatedJsDoc.name || ''
			propertySchema.description = validatedJsDoc.description || ''
			propertySchema.editor =
				(validatedJsDoc.editor as SchemaProperty['editor']) || 'textfield'
			propertySchema.default = validatedJsDoc.default
			propertySchema.prefill = validatedJsDoc.prefill
		}

		const propertyType = checker.getTypeOfSymbol(property)

		if (
			propertyType.isClassOrInterface() ||
			(propertyType.flags & TypeFlags.Object &&
				!(propertyType.flags & ts.TypeFlags.Enum) &&
				!(propertyType.flags & ts.TypeFlags.EnumLiteral)) &&
				!(propertyType.flags & ts.TypeFlags.Union && !(propertyType.flags & ts.TypeFlags.Boolean))
		) {
			propertySchema.type = 'object'
		} else if (
			propertyType.flags & ts.TypeFlags.Enum ||
			propertyType.flags & ts.TypeFlags.EnumLiteral ||
			(propertyType.flags & ts.TypeFlags.Union && !(propertyType.flags & ts.TypeFlags.Boolean))
		) {
			propertySchema.type = 'enum'
		} else {
			propertySchema.type = checker.typeToString(propertyType) as any
		}

		switch (propertySchema.type) {
			case 'object':
				propertySchema.properties = convertObjectToSchema(checker, propertyType as any, [
					...interfacePath,
					property.name,
				])

				if (propertySchema.default) {
					const treated = propertySchema.default as string
					const parsedJSON = JSON.parse(
						treated
							.replace(/(?:['"])?([a-z0-9A-Z_]+)(?:['"])?:/g, '"$1": ')
							.replace(/:\s*?(?:'([^']*)')/g, ': "$1"')
							.replace(
								/\s*"[^"]*":\s*[^(,[\]{}]*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*,?/g,
								''
							)
					)

					const parsed = arktype.type(propertySchema.properties)(parsedJSON)

					if (parsed.problems) {
						console.warn(
							`Default value '${
								propertySchema.default
							}' for '${propertyPath}' does not match schema of ${JSON.stringify(
								propertySchema.properties
							)} because of ${parsed.problems}`
						)
					}

					propertySchema.default = parsed.data as Object | undefined
				}

				break
			case 'enum':
				propertySchema.enum = convertEnumlikeIntoEnum(checker, propertyType as ts.EnumType)

				if (
					propertySchema.default &&
					!propertySchema.enum.includes(propertySchema.default)
				) {
					console.warn(
						`Default value '${
							propertySchema.default
						}' for '${propertyPath}' does not match enum of ${JSON.stringify(
							propertySchema.enum
						)}`
					)
				}
				break
			case 'number':
				propertySchema.default &&= Number(propertySchema.default)
				propertySchema.prefill &&= Number(propertySchema.prefill)
				break
			case 'boolean':
				propertySchema.default &&= Boolean(propertySchema.default)
				propertySchema.prefill &&= Boolean(propertySchema.prefill)
				break
		}

		propertySchema.editor = EDITOR_TYPE_MAP[propertySchema.type] || 'textfield'
		propertySchema.required = (property.flags & ts.SymbolFlags.Optional) === 0

		if (!propertySchema.required && propertySchema.default !== undefined) {
			console.warn(`Missing default for required '${propertyPath}'`)
		}

		if (propertySchema.title === '') {
			console.warn(`Missing title for '${propertyPath}'`)
			propertySchema.title = property.name
		}

		if (propertySchema.description === '') {
			console.warn(`Missing description for '${propertyPath}'`)
		}

		schema[property.name] = propertySchema
	}

	return schema
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
