/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, html, css} from 'lit';
import {customElement, property} from 'lit/decorators.js';

type Theme = 'dark' | 'light' | 'system';
const prefersDark = window.matchMedia('(prefers-color-scheme:dark)');

const darkIcon = html`<svg
  xmlns="http://www.w3.org/2000/svg"
  height="40"
  width="40"
  fill="currentcolor"
>
  <path
    d="M20 35q-6.25 0-10.625-4.375T5 20q0-5.667 3.458-9.687 3.459-4.021 9-5.021 1.459-.25 2.084.646.625.895-.042 2.27-.5 1-.75 2.084-.25 1.083-.25 2.208 0 3.75 2.625 6.375T27.5 21.5q1.125 0 2.208-.25 1.084-.25 2-.708 1.5-.625 2.396.041.896.667.563 2.209-.959 5.25-5 8.729Q25.625 35 20 35Zm0-2.792q4.25 0 7.479-2.541 3.229-2.542 4.229-6.167-1 .375-2.062.583-1.063.209-2.146.209-4.875 0-8.333-3.459-3.459-3.458-3.459-8.333 0-.958.188-2 .187-1.042.604-2.292-3.792 1.209-6.25 4.48Q7.792 15.958 7.792 20q0 5.083 3.562 8.646 3.563 3.562 8.646 3.562Zm-.25-12Z"
  />
</svg>`;

const lightIcon = html`<svg
  xmlns="http://www.w3.org/2000/svg"
  height="40"
  width="40"
  fill="currentcolor"
>
  <path
    d="M20 25.542q2.292 0 3.917-1.604 1.625-1.605 1.625-3.938 0-2.292-1.604-3.917-1.605-1.625-3.938-1.625-2.292 0-3.917 1.604-1.625 1.605-1.625 3.938 0 2.292 1.604 3.917 1.605 1.625 3.938 1.625Zm0 2.791q-3.458 0-5.896-2.437-2.437-2.438-2.437-5.896 0-3.458 2.437-5.896 2.438-2.437 5.896-2.437 3.458 0 5.896 2.437 2.437 2.438 2.437 5.896 0 3.458-2.437 5.896-2.438 2.437-5.896 2.437ZM3.042 21.375q-.584 0-.98-.396-.395-.396-.395-.979t.395-.979q.396-.396.98-.396h3.916q.584 0 .979.396.396.396.396.979t-.396.979q-.395.396-.979.396Zm30 0q-.584 0-.98-.396-.395-.396-.395-.979t.395-.979q.396-.396.98-.396h3.916q.584 0 .98.396.395.396.395.979t-.395.979q-.396.396-.98.396ZM20 8.333q-.583 0-.979-.395-.396-.396-.396-.98V3.042q0-.584.396-.979.396-.396.979-.396t.979.396q.396.395.396.979v3.916q0 .584-.396.98-.396.395-.979.395Zm0 30q-.583 0-.979-.395-.396-.396-.396-.98v-3.916q0-.584.396-.98.396-.395.979-.395t.979.395q.396.396.396.98v3.916q0 .584-.396.98-.396.395-.979.395ZM9.792 11.75 7.625 9.625q-.417-.417-.396-1 .021-.583.396-1 .417-.417 1-.417t1 .417l2.125 2.167q.375.416.375.979 0 .562-.375.979-.375.375-.958.375-.584 0-1-.375Zm20.583 20.625-2.125-2.167q-.375-.416-.375-1 0-.583.375-.958.417-.417.979-.417.563 0 .979.417l2.167 2.125q.417.417.396 1-.021.583-.396 1-.417.417-1 .417t-1-.417ZM28.25 11.75q-.417-.417-.417-.979 0-.563.417-.979l2.125-2.167q.417-.417 1-.396.583.021 1 .396.417.417.417 1t-.417 1l-2.167 2.125q-.416.375-.979.375-.562 0-.979-.375ZM7.625 32.375q-.417-.417-.417-1t.417-1l2.167-2.125q.416-.417.979-.417.562 0 .979.417.417.417.417.979 0 .563-.417.979l-2.125 2.167q-.417.417-1 .396-.583-.021-1-.396ZM20 20Z"
  />
</svg> `;

@customElement('wireit-theme-picker')
export class WireitThemePicker extends LitElement {
  @property({reflect: true})
  theme: Theme = (() => {
    const val = localStorage.getItem('theme');
    if (val === 'dark' || val === 'light') {
      return val;
    }
    return prefersDark.matches ? 'dark' : 'light';
  })();

  static override styles = css`
    button {
      background: none;
      border: none;
      cursor: pointer;
      color: inherit;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    prefersDark.addEventListener('change', this._prefersColorSchemeDarkChanged);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    prefersDark.removeEventListener(
      'change',
      this._prefersColorSchemeDarkChanged
    );
  }

  private _prefersColorSchemeDarkChanged = () => {
    if (this.theme === 'system') {
      this.requestUpdate();
    }
  };

  override render() {
    const theme =
      this.theme === 'system'
        ? prefersDark.matches
          ? 'dark'
          : 'light'
        : this.theme;
    return html`<button @click=${this._toggleTheme}>
      ${theme === 'light' ? lightIcon : darkIcon}
    </button>`;
  }

  private _toggleTheme() {
    this._savePreference(this.theme === 'light' ? 'dark' : 'light');
  }

  private _savePreference(theme: Theme) {
    if (theme === this.theme) {
      return;
    }
    this.theme = theme;
    localStorage.setItem('theme', theme);
    document.body.setAttribute('theme', theme);
  }
}
