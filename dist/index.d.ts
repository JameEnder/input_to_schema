#!/usr/bin/env node
type IntegerSchema = {
    type: 'integer';
    editor: 'number';
    default?: number;
    prefill?: number;
};
type StringSchema = {
    type: 'string';
    editor: 'textfield';
    default?: string;
    prefill?: string;
};
type ObjectSchema = {
    type: 'object';
    editor: 'textfield';
    default?: Object;
    prefill?: Object;
    properties: Record<string, SchemaProperty>;
    required: string[];
};
type EnumSchema = {
    type: ObjectSchema['type'] | BooleanSchema['type'] | ArraySchema['type'] | StringSchema['type'] | IntegerSchema['type'];
    editor: 'select' | 'stringList';
    enum: any[];
    enumTitles?: string[];
    default?: any;
    prefill?: any;
};
type BooleanSchema = {
    type: 'boolean';
    editor: 'checkmark';
    default?: boolean;
    prefill?: boolean;
};
type ArraySchema = {
    type: 'array';
    editor: 'textfield';
    default?: any[];
    prefill?: any[];
};
type SchemaProperty = {
    title: string;
    description: string;
} & (IntegerSchema | BooleanSchema | StringSchema | ObjectSchema | EnumSchema | ArraySchema);
export declare function convertJsDoccableToString(value: SchemaProperty, required: boolean, level?: number): string;
export declare function convertSchemaToType(name: string, schema: SchemaProperty, required?: boolean, level?: number): string;
export declare function getSchemaFromSourcePath(sourcePath: string, inputFileName: string, typeName?: string): SchemaProperty;
export declare function getSchemaFromSourcePathMultiple(sourcePath: string, inputFileName: string, ignoreTypeName: string, pattern: RegExp): SchemaProperty[];
export declare function multiActorJsonToTypes(actorsFolder: string): string[];
export {};
//# sourceMappingURL=index.d.ts.map