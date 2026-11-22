// The parts of `gleam export package-interface` that rays reads.

export type TypeInterface =
  | {
      kind: "named";
      name: string;
      package: string;
      module: string;
      parameters: TypeInterface[];
    }
  | { kind: "variable"; id: number }
  | { kind: "tuple"; elements: TypeInterface[] }
  | { kind: "fn"; parameters: TypeInterface[]; return: TypeInterface };

export interface ModuleInterface {
  functions: Record<
    string,
    {
      parameters: { label: string | null; type: TypeInterface }[];
      return: TypeInterface;
      implementations: { "can-run-on-javascript": boolean };
    }
  >;
  types: Record<
    string,
    {
      parameters: number;
      constructors: {
        name: string;
        parameters: { label: string | null; type: TypeInterface }[];
      }[];
    }
  >;
}

export type NamedType = Extract<TypeInterface, { kind: "named" }>;

/** How a type reads in an error message. */
export function describeType(type: TypeInterface): string {
  switch (type.kind) {
    case "named":
      return type.module === "gleam"
        ? type.name
        : `${type.module}.${type.name}`;
    case "fn":
      return "a function";
    case "tuple":
      return "a tuple";
    case "variable":
      return "a type variable";
  }
}
