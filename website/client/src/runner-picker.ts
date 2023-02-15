/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, html, css} from 'lit';
import {customElement, property} from 'lit/decorators.js';

type Runner = 'npm' | 'yarn' | 'pnpm';
const runners = new Set<Runner>(['npm', 'yarn', 'pnpm']);

@customElement('wireit-runner-picker')
export class WireitIntroDiagram1 extends LitElement {
  @property({reflect: true})
  mode: Runner = (() => {
    const val = localStorage.getItem('runner');
    if (runners.has(val as Runner)) {
      return val as Runner;
    }
    return 'npm';
  })();

  static override styles = css`
    #container {
      border: 1px solid #a8a8a8;
      border-radius: 20px;
      height: 60px;
      box-sizing: border-box;
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: space-around;
      box-shadow: rgb(0 0 0 / 10%) 0px 0px 5px 0px inset;
    }
    button {
      color: inherit;
      font-family: inherit;
      background: transparent;
      border: none;
      cursor: pointer;
      display: inline-block;
      transition: color 0.1s ease-in-out;
      font-size: inherit;
    }
    button:first-of-type {
      padding-left: 10px;
    }
    button[aria-checked='true'] {
      /* color: white; */
    }
    #pill {
      background: var(--wireit-runner-picker-pill-color, #ccc);
      border-radius: 15px;
      width: 32%;
      height: 85%;
      position: absolute;
      z-index: -1;
      top: 5px;
      transition: left 0.1s ease-in-out, width 0.1s ease-in-out;
    }
    :host([mode='npm']) #pill {
      left: 4px;
    }
    :host([mode='yarn']) #pill {
      left: 31%;
    }
    :host([mode='pnpm']) #pill {
      left: 62%;
      width: 36.5%;
    }
  `;

  override render() {
    return html`
      <div id="container" role="radiogroup" aria-label="Task runner">
        <button
          role="radio"
          aria-label="npm"
          aria-checked=${this.mode === 'npm'}
          @click=${this._setNpm}
        >
          npm
        </button>
        <button
          role="radio"
          aria-label="yarn"
          aria-checked=${this.mode === 'yarn'}
          @click=${this._setYarn}
        >
          yarn
        </button>
        <button
          role="radio"
          aria-label="pnpm"
          aria-checked=${this.mode === 'pnpm'}
          @click=${this._setPnpm}
        >
          pnpm
        </button>
        <span id="pill"></span>
      </div>
    `;
  }

  private _setNpm() {
    this._savePreference('npm');
  }

  private _setYarn() {
    this._savePreference('yarn');
  }

  private _setPnpm() {
    this._savePreference('pnpm');
  }

  private _savePreference(runner: Runner): void {
    if (runner === this.mode) {
      return;
    }
    this.mode = runner;
    localStorage.setItem('runner', runner);
    document.body.setAttribute('runner', runner);
  }
}
