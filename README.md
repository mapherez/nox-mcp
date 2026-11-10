# NoX MCP

The shared MCP library behind NoX app integrations.

NoX MCP lets applications publish tools that an AI assistant can discover and use through the Model Context Protocol (MCP). It also provides the shared definitions that let NoX CLI present those tools as interactive menus.

**You do not install or run NoX MCP as a separate app.** It is included in products that use it. If you want to use those products, install the app itself or [NoX CLI](https://github.com/mapherez/nox-cli); if you want to connect an AI client to your Suite, use [NoX Gateway](https://github.com/mapherez/nox-gateway).

## What it provides

For developers adding MCP or Suite support to an application:

- Native libraries for TypeScript, Go and Rust.
- Tool definitions and input/output validation.
- Timeouts, cancellation, concurrency and payload limits.
- Authentication and authorization integration points.
- Tool discovery and separate human-facing menu metadata.
- Shared product registration, delegation and Gateway contracts.
- Desktop bridges for operations owned by a desktop app.

Each app defines and runs its own operations. NoX MCP supplies common building blocks; it does not contain a fixed catalog of NoX products or their commands.

## Documentation

[SDK integration](Documents/INTEGRATION.md) · [Discovery and menus](Documents/DISCOVERY.md) · [Language support](Documents/COMPATIBILITY.md) · [Documentation index](Documents/README.md)

For products joining Suite: [product integration](Documents/PRODUCT_INTEGRATION_PROPOSAL.md) · [same-host communication](Documents/SUITE_SAME_HOST_INTEGRATION.md) · [Gateway contract](Documents/GATEWAY_CONTRACT.md).

## Usage

This section is for application developers. App users do not need these steps.

### TypeScript

From the application you are developing:

```sh
npm install https://github.com/mapherez/nox-mcp/releases/latest/download/nox-mcp.tgz
```

```ts
import { createServer } from '@nox/mcp';
```

### Go

From your application's Go module directory:

```sh
go get github.com/mapherez/nox-mcp
go mod tidy
```

```go
import noxmcp "github.com/mapherez/nox-mcp/go"
```

### Rust

Add the crate as a Git dependency in your application's `Cargo.toml`. The [integration guide](Documents/INTEGRATION.md#consume-the-released-sdk) provides the dependency declaration and release-pinning instructions.

Follow the [integration guide](Documents/INTEGRATION.md) to define tools, connect them to existing app functionality and select a transport. Application data and domain permissions stay with the application that uses the library. See [language support](Documents/COMPATIBILITY.md) for supported transports and limitations.

## License & Attribution

This project is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)** license.

### How to Credit This Project

If you use, fork, or modify this code, you **must** provide attribution by linking back to my GitHub profile. Please include the following credit notice prominently in your repository or project documentation:

> **Based on [nox-mcp](https://github.com/mapherez/nox-mcp) by [mapherez](https://github.com/mapherez)**
> This project includes code from [nox-mcp](https://github.com/mapherez/nox-mcp), used under the CC BY-NC-SA 4.0 license.

---

*For more details on what you can and cannot do, please refer to the [LICENSE](LICENSE) file in this repository.*

## Disclaimer of Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
