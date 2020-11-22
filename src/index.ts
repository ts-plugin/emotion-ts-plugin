import * as ts from 'typescript'
import { SourceMapGenerator } from 'source-map'
import * as convert from 'convert-source-map'
import { basename, relative, extname, normalize } from 'path'
import { memoize } from 'lodash'
import findRoot from 'find-root'

const hashString = require('@emotion/hash').default

interface ModuleConfig {
  moduleName: string
  includesSubPath?: boolean
  exportedNames: string[]
  styledName?: string
  hasDefaultExport?: boolean
}

interface ImportInfo extends ModuleConfig {
  name: string
  type: 'namedImport' | 'namespaceImport' | 'defaultImport'
}

export interface Options {
  sourcemap?: boolean
  autoLabel?: boolean
  labelFormat?: string
  autoInject?: boolean
  customModules?: ModuleConfig[]
  jsxFactory?: string
  jsxImportSource?: string
}

const defaultEmotionModules: ModuleConfig[] = [
  {
    moduleName: '@emotion/styled',
    exportedNames: ['styled'],
    hasDefaultExport: true,
    styledName: 'styled',
  },
  {
    moduleName: '@emotion/react',
    exportedNames: ['css'],
  },
]

const defaultOptions: Options = {
  sourcemap: true,
  autoLabel: true,
  labelFormat: '[local]',
  autoInject: true,
}

const getPackageRootPath = memoize((filename: string) => findRoot(filename))
const hashArray = (arr: Array<string>) => hashString(arr.join(''))

const createImportJSXAst = memoize((propertyName: string | undefined) => {
  const importClause = ts.factory.createImportClause(
    false,
    undefined,
    ts.factory.createNamedImports([
      propertyName
        ? ts.factory.createImportSpecifier(
            ts.factory.createIdentifier('jsx'),
            ts.factory.createIdentifier(propertyName),
          )
        : ts.factory.createImportSpecifier(
            undefined,
            ts.factory.createIdentifier('jsx'),
          ),
    ]),
  )
  const moduleSpecifier = ts.factory.createStringLiteral('@emotion/react')

  return ts.factory.createImportDeclaration(
    undefined,
    undefined,
    importClause,
    moduleSpecifier,
  )
})

export const createEmotionPlugin = (pluginOptions?: Options) => {
  const options = { ...defaultOptions, ...pluginOptions }
  const modules = new Map(
    defaultEmotionModules
      .concat(options.customModules || [])
      .map((m) => [m.moduleName, m]),
  )

  function getImportCalls(
    importDeclarationNode: ts.ImportDeclaration,
    compilerOptions: ts.CompilerOptions,
  ) {
    const importCalls: ImportInfo[] = []
    const moduleName = (<ts.StringLiteral>importDeclarationNode.moduleSpecifier)
      .text
    if (!importDeclarationNode.importClause) {
      return importCalls
    }
    const { name, namedBindings } = importDeclarationNode.importClause!
    for (const moduleInfo of modules.values()) {
      if (
        moduleInfo.moduleName === moduleName ||
        (moduleInfo.includesSubPath &&
          moduleName.includes(moduleInfo.moduleName + '/'))
      ) {
        // import lib from 'lib'
        if (name) {
          if (moduleInfo.hasDefaultExport) {
            importCalls.push({
              name: name.text,
              type: 'defaultImport',
              ...moduleInfo,
            })
          } else if (compilerOptions.allowSyntheticDefaultImports) {
            // treat it as import * as emotion from 'emotion'
            importCalls.push({
              name: name.text,
              type: 'namespaceImport',
              ...moduleInfo,
            })
          }
        }

        if (namedBindings) {
          // import { xxx } from 'lib'
          if (ts.isNamedImports(namedBindings)) {
            namedBindings.elements.forEach((node) => {
              // import { default as lib, a as alias, b } from 'lib'
              if (
                // propertyName's existence means alias
                node.propertyName
                  ? moduleInfo.exportedNames.includes(node.propertyName.text) ||
                    (node.propertyName.text === 'default' &&
                      moduleInfo.hasDefaultExport)
                  : moduleInfo.exportedNames.includes(node.name.text)
              ) {
                importCalls.push({
                  name: node.name.text,
                  type: 'namedImport',
                  ...moduleInfo,
                })
              }
            })
          } else if (ts.isNamespaceImport(namedBindings)) {
            // import * as xxx from 'lib'
            importCalls.push({
              name: namedBindings.name!.text,
              type: 'namespaceImport',
              ...moduleInfo,
            })
          }
        }
      }
    }
    return importCalls
  }

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    let importCalls: ImportInfo[] = []
    const compilerOptions = context.getCompilerOptions()
    let sourcemapGenerator: SourceMapGenerator
    let emotionTargetClassNameCount = 0
    let sourceFile: ts.SourceFile
    let inserted = false
    const visitor: ts.Visitor = (node) => {
      if (ts.isImportDeclaration(node)) {
        importCalls = importCalls.concat(getImportCalls(node, compilerOptions))
        // insert import { jsx [as jsxFactory] } from '@emotion/react' behind the react import declaration
        if (
          !inserted &&
          options.autoInject &&
          (<ts.StringLiteral>node.moduleSpecifier).text === 'react'
        ) {
          inserted = true
          return [
            createImportJSXAst(
              options?.jsxFactory ?? compilerOptions.jsxFactory,
            ),
            node,
          ]
        }
        return node
      }

      if (options.autoLabel || options.sourcemap) {
        if (ts.isCallExpression(node)) {
          let { expression } = node
          if (
            ts.isCallExpression(expression) ||
            ts.isPropertyAccessExpression(expression) ||
            ts.isIdentifier(expression)
          ) {
            const { expression: subExpression } = ts.isIdentifier(expression)
              ? node
              : (expression as ts.CallExpression | ts.PropertyAccessExpression)
            let transformedNode = node
            let updateCallFunction = () => transformedNode
            // styled.div({}) => styled('div')({})
            if (ts.isPropertyAccessExpression(expression)) {
              const info = importCalls.find((importInfo) => {
                const expr = (expression as ts.PropertyAccessExpression)
                  .expression
                return (
                  importInfo.styledName ===
                  (ts.isIdentifier(expr)
                    ? expr.text
                    : ts.isPropertyAccessExpression(expr)
                    ? expr.name.text
                    : '')
                )
              })
              if (info) {
                expression = ts.factory.createCallExpression(
                  expression.expression,
                  [],
                  [ts.factory.createStringLiteral(expression.name.text)],
                )
              }
            }
            const exp = ts.isCallExpression(expression) ? expression : null
            if (exp) {
              updateCallFunction = () => {
                if (exp.arguments.length >= 1) {
                  const filename = sourceFile.fileName
                  let moduleName = ''
                  let rootPath = filename

                  try {
                    rootPath = getPackageRootPath(filename)
                    moduleName = require(rootPath + '/package.json').name
                  } catch (err) {
                    //
                  }
                  const finalPath =
                    filename === rootPath
                      ? 'root'
                      : filename.slice(rootPath.length)

                  const positionInFile = emotionTargetClassNameCount++

                  const stuffToHash = [moduleName]

                  if (finalPath) {
                    stuffToHash.push(normalize(finalPath))
                  } else {
                    stuffToHash.push(sourceFile.getText())
                  }

                  const stableClassName = `e${hashArray(
                    stuffToHash,
                  )}${positionInFile}`
                  const [el, opts] = exp.arguments
                  const targetAssignment = ts.factory.createPropertyAssignment(
                    ts.factory.createIdentifier('target'),
                    ts.factory.createStringLiteral(stableClassName),
                  )
                  const args = [el]
                  args.push(
                    ts.factory.createObjectLiteralExpression(
                      opts && ts.isObjectLiteralExpression(opts)
                        ? opts.properties.concat(targetAssignment)
                        : [targetAssignment],
                      true,
                    ),
                  )

                  const updatedCall = ts.factory.updateCallExpression(
                    exp,
                    exp.expression,
                    exp.typeArguments,
                    args,
                  )

                  return ts.factory.updateCallExpression(
                    transformedNode,
                    updatedCall,
                    transformedNode.typeArguments,
                    transformedNode.arguments,
                  )
                }
                return transformedNode
              }
            }
            if (
              ts.isIdentifier(subExpression) ||
              ts.isPropertyAccessExpression(subExpression)
            ) {
              const importedInfo = ts.isIdentifier(subExpression)
                ? importCalls.find(
                    (imported) => imported.name === subExpression.text,
                  )
                : importCalls.find(
                    (imported) =>
                      imported.name ===
                      (subExpression.expression as ts.Identifier).text,
                  )
              if (importedInfo) {
                if (options.autoLabel) {
                  const rawPath = sourceFile.fileName
                  const localNameNode = (node.parent as ts.VariableDeclaration)
                    .name
                  if (localNameNode && ts.isIdentifier(localNameNode)) {
                    const local = localNameNode.text
                    const fileName = basename(rawPath, extname(rawPath))
                    transformedNode = ts.factory.updateCallExpression(
                      transformedNode,
                      transformedNode.expression,
                      transformedNode.typeArguments,
                      transformedNode.arguments.concat([
                        ts.factory.createStringLiteral(
                          `label:${options
                            .labelFormat!.replace('[local]', local)
                            .replace('[filename]', fileName)};`,
                        ),
                      ]),
                    )
                  }
                }
                if (
                  options.sourcemap &&
                  process.env.NODE_ENV !== 'production'
                ) {
                  const sourceFileNode = node.getSourceFile()
                  const lineAndCharacter = ts.getLineAndCharacterOfPosition(
                    sourceFileNode,
                    node.pos,
                  )
                  const sourceFileName = relative(
                    process.cwd(),
                    sourceFileNode.fileName,
                  )
                  sourcemapGenerator.addMapping({
                    generated: {
                      line: 1,
                      column: 0,
                    },
                    source: sourceFileName,
                    original: {
                      line: lineAndCharacter.line + 1,
                      column: lineAndCharacter.character + 1,
                    },
                  })
                  sourcemapGenerator.setSourceContent(
                    sourceFileName,
                    sourceFileNode.text,
                  )
                  const comment = convert
                    .fromObject(sourcemapGenerator)
                    .toComment({ multiline: true })
                  transformedNode = ts.factory.updateCallExpression(
                    transformedNode,
                    transformedNode.expression,
                    transformedNode.typeArguments,
                    transformedNode.arguments.concat([
                      ts.factory.createStringLiteral(comment),
                    ]),
                  )
                }
                transformedNode = ts.addSyntheticLeadingComment(
                  transformedNode,
                  ts.SyntaxKind.MultiLineCommentTrivia,
                  '#__PURE__',
                )
                return updateCallFunction()
              }
            }
          }
        }
      }

      return ts.visitEachChild(node, visitor, context)
    }
    return (node) => {
      sourceFile = node
      sourcemapGenerator = new SourceMapGenerator({
        file: basename(node.fileName),
        sourceRoot: '',
      })
      const distNode = ts.visitNode(node, visitor)
      if (inserted && options.jsxImportSource && distNode.statements.length) {
        // fIXME
        // typeScript private API https://github.com/microsoft/TypeScript/pull/39199/files#diff-1516c8349f7a625a2e4a2aa60f6bbe84e4b1a499128e8705d3087d893e01d367R5974
        // @ts-expect-error
        distNode.pragmas.set('jsximportsource', {
          arguments: {
            factory: options.jsxImportSource,
          },
        })
      }
      importCalls = []
      inserted = false
      emotionTargetClassNameCount = 0
      return distNode
    }
  }
  return transformer
}
