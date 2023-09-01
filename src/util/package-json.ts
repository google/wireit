/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {findNamedNodeAtLocation, JsonFile} from './ast.js';
import {JsonAstNode, NamedAstNode} from './ast.js';
import {Failure} from '../event.js';
import {
  failUnlessJsonObject,
  failUnlessKeyValue,
  failUnlessNonBlankString,
} from '../analyzer.js';
import {offsetInsideNamedNode, offsetInsideRange} from '../error.js';

export interface ScriptSyntaxInfo {
  name: string;
  /** The node for this script in the scripts section of the package.json */
  scriptNode?: NamedAstNode<string>;
  /** The node for this script in the wireit section of the package.json */
  wireitConfigNode?: NamedAstNode;
}

export type LocationSyntaxInfo =
  | {kind: 'scripts-section-script'; scriptSyntaxInfo: ScriptSyntaxInfo}
  | {kind: 'wireit-section-script'; scriptSyntaxInfo: ScriptSyntaxInfo};

/**
 * A parsed and minimally analyzed package.json file.
 *
 * This does some very basic syntactic analysis of the package.json file,
 * finding issues like "the scripts section isn't an object mapping strings to
 * strings" and "the wireit section isn't an object mapping strings to objects".
 *
 * Makes it easy to find the syntax nodes for a script.
 *
 * Does not do any validation or analysis of the wireit script configs.
 *
 * This class exists in part so that we walk the package.json file only once,
 * and in part so that we generate file-level syntactic diagnostics only once,
 * so that we can do better deduplication of errors.
 */
export class PackageJson {
  readonly jsonFile: JsonFile;
  // We keep the file level AST node private to represent the invariant that
  // we only walk the file once, in this class, and nowhere else.
  readonly #fileAstNode: JsonAstNode;
  readonly #scripts: Map<string, ScriptSyntaxInfo> = new Map();
  readonly failures: readonly Failure[];
  readonly scriptsSection: NamedAstNode | undefined = undefined;
  readonly wireitSection: NamedAstNode | undefined = undefined;
  constructor(jsonFile: JsonFile, fileAstNode: JsonAstNode) {
    this.jsonFile = jsonFile;
    this.#fileAstNode = fileAstNode;
    const failures: Failure[] = [];
    this.scriptsSection = this.#analyzeScriptsSection(failures);
    this.wireitSection = this.#analyzeWireitSection(failures);
    this.failures = failures;
  }

  getScriptInfo(name: string): ScriptSyntaxInfo | undefined {
    return this.#scripts.get(name);
  }

  get scripts() {
    return this.#scripts.values();
  }

  getInfoAboutLocation(offset: number): LocationSyntaxInfo | undefined {
    if (this.scriptsSection && offsetInsideRange(offset, this.scriptsSection)) {
      for (const scriptSyntaxInfo of this.scripts) {
        if (
          scriptSyntaxInfo.scriptNode &&
          offsetInsideNamedNode(offset, scriptSyntaxInfo.scriptNode)
        ) {
          return {kind: 'scripts-section-script', scriptSyntaxInfo};
        }
      }
    } else if (
      this.wireitSection &&
      offsetInsideRange(offset, this.wireitSection)
    ) {
      for (const scriptSyntaxInfo of this.scripts) {
        if (
          scriptSyntaxInfo.wireitConfigNode &&
          offsetInsideNamedNode(offset, scriptSyntaxInfo.wireitConfigNode)
        ) {
          return {kind: 'wireit-section-script', scriptSyntaxInfo};
        }
      }
    }
  }

  _getOrMakeScriptInfo(name: string): ScriptSyntaxInfo {
    let info = this.#scripts.get(name);
    if (info === undefined) {
      info = {name};
      this.#scripts.set(name, info);
    }
    return info;
  }

  /**
   * Do some basic structural validation of the "scripts" section of this
   * package.json file. Create placeholders for each of the declared scripts and
   * add them to this._scripts.
   */
  #analyzeScriptsSection(failures: Failure[]): undefined | NamedAstNode {
    const scriptsSectionResult = findNamedNodeAtLocation(
      this.#fileAstNode,
      ['scripts'],
      this.jsonFile,
    );
    if (!scriptsSectionResult.ok) {
      failures.push(scriptsSectionResult.error);
      return;
    }
    const scriptsSection = scriptsSectionResult.value;
    if (scriptsSection === undefined) {
      return;
    }
    const fail = failUnlessJsonObject(scriptsSection, this.jsonFile);
    if (fail !== undefined) {
      failures.push(fail);
      return;
    }
    for (const child of scriptsSection.children ?? []) {
      if (child.type !== 'property') {
        continue;
      }
      if (child.children === undefined) {
        continue;
      }
      const nameAndValueResult = failUnlessKeyValue(
        child,
        child.children,
        this.jsonFile,
      );
      if (!nameAndValueResult.ok) {
        failures.push(nameAndValueResult.error);
        continue;
      }
      const [rawName, rawValue] = nameAndValueResult.value;
      const nameResult = failUnlessNonBlankString(rawName, this.jsonFile);
      if (!nameResult.ok) {
        failures.push(nameResult.error);
        continue;
      }
      const valueResult = failUnlessNonBlankString(rawValue, this.jsonFile);
      if (!valueResult.ok) {
        failures.push(valueResult.error);
        continue;
      }
      const scriptAstNode = valueResult.value as NamedAstNode<string>;
      scriptAstNode.name = nameResult.value;
      this._getOrMakeScriptInfo(nameResult.value.value).scriptNode =
        scriptAstNode;
    }
    return scriptsSectionResult.value;
  }

  /**
   * Do some basic structural validation of the "wireit" section of this
   * package.json file.
   *
   * Create placeholders for each of the declared scripts and
   * add them to this._scripts.
   *
   * Does not do any validation of any wireit configs themselves, that's done
   * on demand when executing, or all at once when finding all diagnostics.
   */
  #analyzeWireitSection(failures: Failure[]): undefined | NamedAstNode {
    const wireitSectionResult = findNamedNodeAtLocation(
      this.#fileAstNode,
      ['wireit'],
      this.jsonFile,
    );
    if (!wireitSectionResult.ok) {
      failures.push(wireitSectionResult.error);
      return;
    }
    const wireitSection = wireitSectionResult.value;
    if (wireitSection === undefined) {
      return;
    }
    const fail = failUnlessJsonObject(wireitSection, this.jsonFile);
    if (fail !== undefined) {
      failures.push(fail);
      return;
    }
    for (const child of wireitSection.children ?? []) {
      if (child.type !== 'property') {
        continue;
      }
      if (child.children === undefined) {
        continue;
      }
      const nameAndValueResult = failUnlessKeyValue(
        child,
        child.children,
        this.jsonFile,
      );
      if (!nameAndValueResult.ok) {
        failures.push(nameAndValueResult.error);
        continue;
      }
      const [rawName, rawValue] = nameAndValueResult.value;
      const nameResult = failUnlessNonBlankString(rawName, this.jsonFile);
      if (!nameResult.ok) {
        failures.push(nameResult.error);
        continue;
      }
      const fail = failUnlessJsonObject(rawValue, this.jsonFile);
      if (fail !== undefined) {
        failures.push(fail);
        continue;
      }
      const wireitConfigNode = rawValue as NamedAstNode;
      wireitConfigNode.name = nameResult.value;
      this._getOrMakeScriptInfo(nameResult.value.value).wireitConfigNode =
        wireitConfigNode;
    }
    return wireitSectionResult.value;
  }
}
