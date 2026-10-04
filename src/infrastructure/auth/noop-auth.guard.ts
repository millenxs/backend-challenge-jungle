import { Injectable, type CanActivate } from "@nestjs/common";

/**
 * Ponto de extensão de autenticação (não implementada — ver ARCHITECTURE.md, "Autenticação").
 * ponytail: libera tudo; o guard OIDC real deve liberar health/metrics (OpsController) e exigir token no resto.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
