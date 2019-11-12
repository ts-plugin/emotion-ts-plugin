import * as ts from 'typescript'
import { SourceMapGenerator } from 'source-map'
import * as convert from 'convert-source-map'
import { basename, relative, extname, normalize } from 'path'
import { memoize } from 'lodash'
import findRoot from 'find-root'

const hashString = require('@emotion/hash').default

export interface Options {
  sourcemap?: boolean
  autoLabel?: boolean
  labelFormat?: string
  autoInject?: boolean
  customStyledModuleName?: string
}

export interface ImportInfos {
  name: string
  type: 'namedImport' | 'namespaceImport' | 'defaultImport'
  moduleName: string
}

const hasDefaultExports = ['@emotion/styled']
const libraries = ['@emotion/styled', 'emotion', '@emotion/core']
const functions = ['css', 'keyframes', 'injectGlobal', 'merge']

const defaultOptions: Options = {
  sourcemap: true,
  autoLabel: true,
  labelFormat: '[local]',
  autoInject: true,
}

const getPackageRootPath = memoize((filename: string) => findRoot(filename))
const hashArray = (arr: Array<string>) => hashString(arr.join(''))

const createImportJSXAst = memoize((propertyName: string | undefined) => {
  const importClause = ts.createImportClause(
    undefined,
    ts.createNamedImports([
      propertyName
        ? ts.createImportSpecifier(
            ts.createIdentifier('jsx'),
            ts.createIdentifier(propertyName),
          )
        : ts.createImportSpecifier(undefined, ts.createIdentifier('jsx')),
    ]),
  )
  const moduleSpecifier = ts.createStringLiteral('@emotion/core')

  return ts.createImportDeclaration(
    undefined,
    undefined,
    importClause,
    moduleSpecifier,
  )
})

export const createEmotionPlugin = (options?: Options) => {
  const notNullOptions = options
    ? { ...defaultOptions, ...options }
    : { ...defaultOptions }
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    let importCalls: ImportInfos[] = []
    const compilerOptions = context.getCompilerOptions()
    let sourcemapGenerator: SourceMapGenerator
    let emotionTargetClassNameCount = 0
    let sourceFile: ts.SourceFile
    let inserted = false
    const visitor: ts.Visitor = (node) => {
      if (ts.isSourceFile(node)) {
        inserted = false
        return ts.visitEachChild(node, visitor, context)
      }
      if (ts.isImportDeclaration(node)) {
        importCalls = importCalls.concat(getImportCalls(node, compilerOptions))
        // insert import { jsx [as jsxFactory] } from '@emotion/core' behind the react import declaration
        if (
          !inserted &&
          notNullOptions.autoInject &&
          (<ts.StringLiteral>node.moduleSpecifier).text === 'react'
        ) {
          inserted = true
          return [createImportJSXAst(compilerOptions.jsxFactory), node]
        }
        return node
      }

      if (notNullOptions.autoLabel || notNullOptions.sourcemap) {
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
            if (ts.isPropertyAccessExpression(expression)) {
              const info = importCalls.find(
                (importInfo) =>
                  importInfo.name ===
                  ((expression as ts.PropertyAccessExpression)
                    .expression as ts.Identifier).text,
              )
              if (
                info &&
                (info.moduleName === '@emotion/styled' ||
                  (notNullOptions.customStyledModuleName != undefined &&
                    notNullOptions.customStyledModuleName === info.moduleName))
              ) {
                expression = ts.createCall(
                  expression.expression,
                  [],
                  [ts.createStringLiteral(expression.name.text)],
                )
              }
            }
            const exp = ts.isCallExpression(expression) ? expression : null
            if (exp) {
              updateCallFunction = () => {
                if (exp.arguments.length === 1) {
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
                  const updatedCall = ts.updateCall(
                    exp,
                    exp.expression,
                    exp.typeArguments,
                    exp.arguments.concat([
                      ts.createObjectLiteral(
                        [
                          ts.createPropertyAssignment(
                            ts.createIdentifier('target'),
                            ts.createStringLiteral(stableClassName),
                          ),
                        ],
                        true,
                      ),
                    ]),
                  )
                  return ts.updateCall(
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
                const propertyToAccess =
                  importedInfo.type === 'namespaceImport'
                    ? (
                        (expression as ts.PropertyAccessExpression).name ||
                        (subExpression as ts.PropertyAccessExpression).name
                      ).text
                    : ''
                const isEmotionCall =
                  (importedInfo.type === 'namespaceImport' &&
                    (propertyToAccess === 'default' ||
                      functions.includes(propertyToAccess))) ||
                  importedInfo.type !== 'namespaceImport'

                if (isEmotionCall) {
                  if (notNullOptions.autoLabel) {
                    const rawPath = sourceFile.fileName
                    const localNameNode = (node.parent as ts.VariableDeclaration)
                      .name
                    if (localNameNode && ts.isIdentifier(localNameNode)) {
                      const local = localNameNode.text
                      const fileName = basename(rawPath, extname(rawPath))
                      transformedNode = ts.updateCall(
                        transformedNode,
                        transformedNode.expression,
                        transformedNode.typeArguments,
                        transformedNode.arguments.concat([
                          ts.createStringLiteral(
                            `label:${notNullOptions
                              .labelFormat!.replace('[local]', local)
                              .replace('[filename]', fileName)};`,
                          ),
                        ]),
                      )
                    }
                  }
                  if (
                    notNullOptions.sourcemap &&
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
                    transformedNode = ts.updateCall(
                      transformedNode,
                      transformedNode.expression,
                      transformedNode.typeArguments,
                      transformedNode.arguments.concat([
                        ts.createStringLiteral(comment),
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
      importCalls = []
      return distNode
    }
  }
  return transformer
}

function getImportCalls(
  importDeclarationNode: ts.ImportDeclaration,
  compilerOptions: ts.CompilerOptions,
) {
  const importCalls: ImportInfos[] = []
  const moduleName = (<ts.StringLiteral>importDeclarationNode.moduleSpecifier)
    .text
  if (!importDeclarationNode.importClause) {
    return importCalls
  }
  const { name, namedBindings } = importDeclarationNode.importClause!
  if (libraries.includes(moduleName)) {
    if (name) {
      // import emotion from 'emotion'
      // treat it as import * as emotion from 'emotion'
      if (
        moduleName === 'emotion' &&
        compilerOptions.allowSyntheticDefaultImports
      ) {
        importCalls.push({
          name: name.text,
          type: 'namespaceImport',
          moduleName,
        })
      } else if (hasDefaultExports.includes(moduleName)) {
        importCalls.push({
          name: name.text,
          type: 'defaultImport',
          moduleName,
        })
      }
    }
    if (namedBindings) {
      if (ts.isNamedImports(namedBindings)) {
        namedBindings.forEachChild((node) => {
          // import { default as styled } from '@emotion/styled'
          // push styled into importCalls
          if (
            hasDefaultExports.includes(moduleName) &&
            (node as ts.ImportSpecifier).propertyName &&
            (node as ts.ImportSpecifier).propertyName!.text === 'default'
          ) {
            importCalls.push({
              name: (node as ts.ImportSpecifier).name!.text,
              type: 'namedImport',
              moduleName,
            })
          }
          // import { css as emotionCss } from 'lib in libraries'
          // push emotionCss into importCalls
          if (
            (node as ts.ImportSpecifier).propertyName &&
            functions.includes((node as ts.ImportSpecifier).propertyName!.text)
          ) {
            importCalls.push({
              name: (node as ts.ImportSpecifier).name!.text,
              type: 'namedImport',
              moduleName,
            })
          }
          // import { css } from 'lib in libraries'
          // push css into importCalls
          if (
            !(node as ts.ImportSpecifier).propertyName &&
            functions.includes((node as ts.ImportSpecifier).name!.text)
          ) {
            importCalls.push({
              name: (node as ts.ImportSpecifier).name!.text,
              type: 'namedImport',
              moduleName,
            })
          }
        })
      } else {
        importCalls.push({
          name: namedBindings.name!.text,
          type: 'namespaceImport',
          moduleName,
        })
      }
    }
  }
  return importCalls
}
