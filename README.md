# NoX MCP

Shared building blocks for connecting applications to AI tools and NoX Suite.

NoX MCP is a library for developers building integrations with the Model Context Protocol (MCP). MCP lets an application expose useful operations as tools that an AI client can discover and call. NoX MCP provides the common infrastructure around those tools, so each application can focus on its own functionality.

Native libraries are available for **TypeScript, Go and Rust**, backed by shared contracts. NoX MCP runs inside the application that uses it; it is not a separate service to install or manage.

## What it provides

| Capability | What it does |
| --- | --- |
| Tool registration | Describe an application's operations, inputs and outputs using a consistent interface. |
| Validation | Check arguments, results and shared documents against their schemas. |
| Execution controls | Apply timeouts, cancellation, concurrency and payload limits. |
| Authorization | Enforce trusted identities, scopes and product-specific access rules. |
| Discovery | Let clients find available tools and retrieve their definitions without repeatedly loading the entire catalog. |
| Human interaction metadata | Publish labels, selections, previews and workflows separately from the ordinary AI-facing tool catalog. |
| Desktop integration | Provide bridges and request brokers for operations owned by a desktop application. |
| Suite integration | Supply shared enrollment, delegation, registry and aggregation contracts for participating products. |

The language implementations share their public contracts while retaining native APIs and execution models. Supported transports and language-specific limitations are documented in [compatibility and support](Documents/COMPATIBILITY.md).

## How it fits into NoX Suite

Each product defines and executes its own tools. NoX MCP supplies the reusable contracts and mechanisms; it does not contain a catalog of product-specific commands.

Backend owns Suite membership and authorization, Yard manages deployments, Gateway discovers and routes tools, and CLI presents the human interface. Those applications implement their own adapters using the shared contracts. Adding a conforming product does not require a new routing branch or command implementation in the SDK, Gateway or CLI.

## Documentation

- [Documentation index](Documents/README.md)
- [SDK integration](Documents/INTEGRATION.md)
- [Discovery and interaction metadata](Documents/DISCOVERY.md)
- [Product integration](Documents/PRODUCT_INTEGRATION_PROPOSAL.md)
- [Gateway and shared trust contract](Documents/GATEWAY_CONTRACT.md)
- [Same-host integration](Documents/SUITE_SAME_HOST_INTEGRATION.md)
- [Schema and contract maintenance](contracts/README.md)

## Usage

Add NoX MCP to the application that will expose or consume tools. Choose the native library for that application's language.

For TypeScript, install the published package asset:

```sh
npm install https://github.com/mapherez/nox-mcp/releases/latest/download/nox-mcp.tgz
```

Import the server API with:

```ts
import { createServer } from '@nox/mcp';
```

For Go, add the module from your application's Go module directory:

```sh
go get github.com/mapherez/nox-mcp
go mod tidy
```

Import the native package with:

```go
import noxmcp "github.com/mapherez/nox-mcp/go"
```

For Rust, use the crate in [`rust/`](rust/) through a Git dependency, following the [integration guide](Documents/INTEGRATION.md#consume-the-released-sdk). Dependency requirements and compatibility details belong in the [support reference](Documents/COMPATIBILITY.md).

Define the tools, bind them to the application's existing operations, and connect the appropriate transport. Authentication, domain permissions and persistent application data remain the host application's responsibility. See the [integration guide](Documents/INTEGRATION.md) for Suite adapters and [discovery examples](Documents/DISCOVERY.md) for server/client setup.

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
