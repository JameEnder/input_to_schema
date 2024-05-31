#!/usr/bin/env node
type IntegerSchema = {
    type: 'integer';
    default?: number;
    prefill?: number;
};
type StringSchema = {
    type: 'string';
    default?: string;
    prefill?: string;
};
type ObjectSchema = {
    type: 'object';
    default?: Object;
    prefill?: Object;
    properties: Record<string, SchemaProperty>;
    required: string[];
};
type EnumSchema = {
    type: ObjectSchema['type'] | BooleanSchema['type'] | ArraySchema['type'] | StringSchema['type'] | IntegerSchema['type'];
    enum: any[];
    enumTitles?: string[];
    default?: any;
    prefill?: any;
};
type BooleanSchema = {
    type: 'boolean';
    default?: boolean;
    prefill?: boolean;
};
type ArraySchema = {
    type: 'array';
    default?: any[];
    prefill?: any[];
};
type SchemaProperty = (IntegerSchema | BooleanSchema | StringSchema | ObjectSchema | EnumSchema | ArraySchema) & JSDocPropertyInfo;
declare const JSDocPropertyInfoSchema: import("arktype").Type<{
    title?: string | undefined;
    description?: string | undefined;
    editor?: string | undefined;
    default?: string | undefined;
    prefill?: string | string[] | undefined;
    id?: string | undefined;
    enumTitles?: string[] | undefined;
    sectionCaption?: string | undefined;
    sectionDescription?: string | undefined;
    required?: string | string[] | undefined;
    uniqueItems?: any[] | undefined;
    example?: any;
    items?: object | undefined;
}, {}>;
type JSDocPropertyInfo = typeof JSDocPropertyInfoSchema.infer;
export declare function convertJsDoccableToString(value: SchemaProperty, required: boolean, level?: number): string;
export declare function convertSchemaToType(name: string, schema: SchemaProperty, required?: boolean, level?: number): string;
export declare function getSchemaFromSourcePath(sourcePath: string, inputFileName: string, typeName?: string): any;
export declare function getSchemaFromSourcePathMultiple(sourcePath: string, inputFileName: string, ignoreTypeName: string, pattern: RegExp): any[];
export declare function multiActorJsonToTypes(actorsFolder: string): string[];
export {};
//# sourceMappingURL=index.d.ts.map