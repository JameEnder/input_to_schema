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
  */
  role: 'admin' | 'normal'
}

const {
  // It can do defaults like so!
  role = 'admin'
} = (await Actor.getInput<Input>())!
```

## Usage
```sh
tsx ./index.ts print <folder_with_main.ts>
```

Or you can get help with

```sh
tsx ./index.ts help print
```

