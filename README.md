# Business Central Object Lookup

This VS Code extension suggests Business Central object references when you type an object ID in an AL file.

For example, typing `27` can show catalog matches such as `Table 27 "Item"`.

The inserted AL depends on where you are:

- In a `var` block, `Table 27 "Item"` inserts `Item: Record Item;`
- In an expression, such as `SomeFunction(27)`, `Table 27 "Item"` inserts `DATABASE::Item`
- Other object types use references such as `Page::Item`, `Codeunit::Item`, and `Report::Item`

## Object Sources

By default, the extension scans the current workspace for:

- `*.al` files, reading object declarations such as `table 27 Item`
- `*.app` packages, reading symbol reference JSON from downloaded Business Central packages

That means standard packages in folders like `.alpackages` and project AL files can be suggested automatically.

The catalog reloads automatically after AL files, app packages, or the configured custom catalog change. File changes update only the changed source in the catalog, and the reload is debounced and silent so it should not interrupt normal editing.

You can still run `Business Central Object Lookup: Reload Catalog` manually when you want a visible full reload status.

## Add More Objects Manually

The bundled catalog is in `data/businessCentralObjects.json`.

You can also point the extension at your own workspace catalog with:

```json
{
  "businessCentralObjectLookup.catalogPath": "bc-object-catalog.json"
}
```

Catalog format:

```json
[
  { "type": "Table", "id": 27, "name": "Item" },
  { "type": "Page", "id": 31, "name": "Item List" }
]
```
