import { info, param } from './utils/out'
import { APIDocument } from './APIDocument'
import { createSourceFile, forEachChild, ScriptTarget, SyntaxKind, Node, JSDoc } from 'typescript'
import { promises as fs } from 'fs'
import { getExportDeclaration, getVariableExport } from './utils/indexParsing'
import {
	CommentObject,
	ReflectionFlagsObject,
	ParameterReflectionObject,
	TypeObject,
	TypeContainer,
} from 'typedoc/dist/lib/serialization'
import {
	isNodeWithJSDoc,
	isClassReflection,
	isMethodReflection,
	isNodeOpaque,
	isNodeInternal,
	isCallableNode,
} from './utils/predicates'
import { typeToString } from './utils/typeHandling'
import { fixReferences } from './utils/refs'

export type NodeLike = {
	name: string
	kindString?: string

	children?: NodeLike[]

	comment?: CommentObject
}

function stripQuotes(name: string): string {
	if (name.startsWith('"') && name.endsWith('"')) {
		return name.slice(1, name.length - 1)
	} else {
		return name
	}
}

class Context {
	constructor(public mod: string, public docSource: Parser) {}

	forMod(mod: string): Context {
		return new Context(stripQuotes(mod), this.docSource)
	}

	// docForKey(key: string): APIDocument {
	// 	const fullKey = `${this.mod}.${key}`
	// 	// const pageName = indexMap[fullKey]
	// 	// debug('fullKey %s pageName %s', fullKey, pageName)

	// 	// if (pageName === undefined) return this.docSource.catchallDoc

	// 	// const path = `api/${pageName}.md`

	// 	// return this.docSource.getDoc(path)
	// }
}

export type NodeWithDoc = Node & {
	jsDoc: JSDoc[]
}

type CallSignatureType = TypeContainer & {
	kindString: 'Call signature' | string
	name: string
	flags: ReflectionFlagsObject
	parameters?: Parameter[]
	comment?: CommentObject
}

type Parameter = ParameterReflectionObject & {
	kindString: 'Parameter'
	name: string
	type: TypeObject
	flags: ReflectionFlagsObject
}

export type NodeWithCallSignature = NodeLike & {
	signatures: CallSignatureType[]
}

export type MethodReflection = NodeLike & {
	implementationOf: CallSignatureType
}
export type ClassReflection = NodeLike & {}

export type ParseIndex = {
	indexMap: { [key: string]: string }
	indexExports: { [key: string]: string }
}

const toFileName = (file: string): string => `${file}.md`
const writeComment = (doc: APIDocument, comment: any) => {
	let { shortText, text } = comment || { shortText: null, text: null }

	if (shortText) doc.comment(fixReferences(shortText))
	if (text) doc.comment(fixReferences(text))
}

export class Parser {
	private documents: Map<string, APIDocument>
	private index: ParseIndex

	/**
	 * Stores references between Classes and Class Method combinations and the document.
	 *
	 * Data format:
	 * "ClassName": "ClassName.md#class-name-slug"
	 * "ClassName.method": "ClassName.md#class-name-method-slug"
	 *
	 * @type {Map<string, string>}
	 */
	private referenceMap: Map<string, string>

	private visitors = {
		Variable: this.visitVariable,
		Module: this.visitClass,
		Enumeration: this.visitClass,
		Class: this.visitClass,
		Interface: this.visitClass,
		Function: this.visitFunction,
		Property: this.visitProperty,
		Method: this.visitMethod,
		'External module': this.visitExternalModule,
		'Type alias': this.visitAlias,
		'Object literal': this.visitObjectLiteral,
	}

	constructor(private typeDoc: NodeLike, private indexTS: string) {
		this.documents = new Map()
		this.referenceMap = new Map()
	}

	public async parse() {
		this.index = await this.preParseIndex(this.indexTS)
		let files = [...new Set(Object.values(this.index.indexExports))]
		console.dir(files, { depth: null })

		// 1. Create destination documents
		files.forEach(file => {
			this.documents.set(file, new APIDocument())
		})

		// 2. Index global references

		// 3. Index local references

		// 4. Parse tree

		this.walk(this.typeDoc)

		// this.documents.forEach((doc, name) => {
		//   doc.toMarkdown()
		//   mkdirpSync(join('docs', 'api'))
		//   fs.writeFile()
		// })

		return this.documents
	}

	private associateMissingReferences() {
		this.documents.forEach(doc => {
			doc.definition(b => {
				doc.orphanedReferences.forEach(ref => {
					let referenceFilename = this.referenceMap.get(ref.identifier)
					if (referenceFilename) b.definition(ref.identifier, referenceFilename)
				})
			})
		})
	}

	async preParseIndex(fileName: string) {
		const ctx: ParseIndex = {
			indexMap: {},
			indexExports: {},
		}

		const source = createSourceFile(
			fileName,
			await fs.readFile(fileName).then(file => file.toString('utf8')),
			ScriptTarget.ES2015,
			/* setParentNodes */ true,
		)

		forEachChild(source, node => {
			switch (node.kind) {
				case SyntaxKind.ExportDeclaration:
					if (isNodeWithJSDoc(node)) getExportDeclaration(ctx, node)
					break
				case SyntaxKind.VariableStatement:
					if (isNodeWithJSDoc(node)) getVariableExport(ctx, node)
					break
			}
		})

		return ctx
	}

	walk(node: NodeLike, doc?: APIDocument) {
		const { name, kindString } = node

		// console.log(`${info(kindString)} ${param(name)}`)

		if (isClassReflection(node)) {
			let maybeDoc = this.documentForName(name)
			if (maybeDoc) doc = maybeDoc
		}

		this.visit(node, doc)

		if (node.children)
			node.children.forEach(node => {
				this.walk(node, doc)
			})
	}

	visit(node: NodeLike, doc?: APIDocument) {
		if (node.kindString) {
			let visitor = this.visitors[node.kindString]
			if (visitor) {
				visitor.apply(this, [node, doc])
			} else {
				console.log(info(`TODO: ${node.kindString}`))
			}
		}
	}

	private visitClass(node: NodeLike, doc?: APIDocument) {
		let { name, children } = node
		console.log(info(`visit Class: ${name}`))

		// let doc = this.documentForName(name)
		if (!doc) return

		doc.section(name)
		writeComment(doc, node.comment)

		// Set class tags as meta data on the doc
		if (node.comment) this.visitClassComment(node.comment, doc)

		if (isNodeOpaque(node)) return
	}

	private visitClassComment(comment: CommentObject, doc: APIDocument) {
		if (!comment.tags) return
		let meta: any = {}
		comment.tags.forEach(tag => {
			meta[tag.tag] = tag.text.trim()

			if (tag.tag === 'class') {
				// Automatically name file after class name
				meta.title = tag.text.trim()
			}
		})

		doc.frontmatter(meta)
	}

	private visitAlias(node: NodeLike) {}
	private visitExternalModule(node: NodeLike) {}
	private visitObjectLiteral(node: NodeLike) {}
	private visitProperty(node: NodeLike) {}
	private visitFunction(node: NodeLike, doc?: APIDocument) {
		console.log(info(`Function ${node.name}`))
	}
	private visitMethod(node: NodeLike, doc?: APIDocument) {
		if (isMethodReflection(node) && doc) {
			let implementationName = (node.implementationOf && node.implementationOf.name) || node.name
			if (node.implementationOf) console.log(info(`Method ${implementationName}`))

			if (isNodeInternal(node)) return

			// let ref = new ContainerReflection(node as any)

			// debugger

			if (isCallableNode(node)) {
				node.signatures.forEach(sig => this.visitCallSignature(sig, doc))

				// node.signatures.forEach(sig => {
				// 	let { name, type, parameters = [] } = sig

				// 	let params = parameters.map(param => {
				// 		let {
				// 			name,
				// 			type,
				// 			flags: { isOptional = false, isExported, isPublic },
				// 			defaultValue,
				// 			comment,
				// 			originalName,
				// 		} = param
				// 		let isReference = type.type === 'reference'
				// 		let { shortText, text } = comment || { shortText: null, text: null }

				// 		let desc = [shortText, text].filter(Boolean).join(`\n`)

				// 		return { name, type, isOptional, isReference, defaultValue, desc }
				// 	})

				// 	// doc.callSignature(params)

				// 	// console.log(name, type, parameters)

				// 	// debugger

				// 	// this.processCallSignature(doc, sig, parent)
				// 	// if (doc.filePath) {
				// 	// 	let name = `${camelcase(parent)}.${sig.name}`
				// 	// 	this.addReference(name, doc)
				// 	// }
				// })
			}
			// doc.parameter(node.name, )
		}
	}

	private visitCallSignature(signature: CallSignatureType, doc: APIDocument) {
		if (!signature.parameters) return
		let { parameters } = signature

		let params = parameters.map(param => {
			let {
				name,
				type,
				flags: { isOptional = false, isExported, isPublic },
				defaultValue,
				comment,
				originalName,
			} = param
			let isReference = type.type === 'reference'
			let { shortText, text } = comment || { shortText: null, text: null }

			let desc = [shortText, text]
				.filter(Boolean)
				.map(fixReferences)
				.join(`\n`)
			let formattedType = typeToString(type)

			return { name, type: formattedType, isOptional, isReference, defaultValue, desc }
		})

		doc.callSignature(params)
	}

	private visitVariable(node: NodeLike) {
		// console.dir(node, { depth: null })
	}

	private documentForName(name: string): APIDocument | null {
		let key = this.index.indexExports[name]
		return this.documents.get(key) || null
	}
}