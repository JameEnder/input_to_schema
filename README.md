## Syntax
You should create a type named `Input` in your main.ts

The Typescript type definition should get picked up automatically, and then you can annotate the rest with JSDoc, like so

```ts
interface Input {
  /**
  * @name Name
  * @description Name of the Account
  * @prefill "John"
  */
  name: string

  /**
  * @name Role
  * @description Role of the account
  * @default "normal"
  */
  role: 'admin' | 'normal'
}
```

## Usage
```sh
tsx ./index.ts print <folder_with_main.ts>
```

