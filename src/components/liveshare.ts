import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import * as vscode from 'vscode'
import * as vsls from 'vsls/vscode'
import { Extension } from 'src/main'

const serviceName = 'pdfSync'
const pdfUpdateNotificationName = 'pdfUpdated'
const requestPdfRequestName = 'getPdf'

interface PdfArgs {
    relativePath: string,
    content: string
}

export class LiveShare {

    private readonly extension: Extension

    private liveshare: vsls.LiveShare | undefined | null
    private hostService: vsls.SharedService | undefined | null
    private guestService: vsls.SharedServiceProxy | undefined | null
    private role: vsls.Role = vsls.Role.None

    constructor(extension: Extension) {
        this.extension = extension
        this.init()
    }

    private async init() {
        this.liveshare = await vsls.getApi()
        if (!this.liveshare) {
            return
        }
        this.sessionRole = this.liveshare.session.role
        this.liveshare.onDidChangeSession(e => this.sessionRole = e.session.role, null)
    }

    private set sessionRole(role: vsls.Role) {
        this.role = role
        if (this.role === vsls.Role.Guest) {
            this.initGuest()
        } else if (this.role === vsls.Role.Host) {
            this.initHost()
        }
    }

    getOutDir(fullPath: string | undefined): string {
        if (this.role === vsls.Role.Guest) {
            return `${os.tmpdir}/LiveShareLatex`
        } else {
            return this.extension.manager.getOutDir(fullPath)
        }
    }

    get isGuest(): boolean {
        return this.role === vsls.Role.Guest
    }

    get isHost(): boolean {
        return this.role === vsls.Role.Host
    }

    /********************************************************************
     *
     * Host
     *
     * *****************************************************************/

    private async initHost() {
        if (this.liveshare) {
            this.hostService = await this.liveshare.shareService(serviceName)
            if (this.hostService) {
                this.hostService.onRequest(requestPdfRequestName, async (args: any[]) => await this.onRequestPdf(args[0]))
            }
        }
    }

    private getPathRelativeToOutDir(fullPath: string) {
        const outDir = this.getOutDir(fullPath)
        return path.relative(outDir, fullPath)
    }

    private async getPdfArgs(pdfPath: string): Promise<PdfArgs> {
        const content = await fs.promises.readFile(pdfPath)
        return {
            relativePath: this.getPathRelativeToOutDir(pdfPath),
            content: content.toString('binary')
        }
    }

    private async onRequestPdf(relativeTexPath: string) {
        const texPath = this.liveshare?.convertSharedUriToLocal(vscode.Uri.parse(relativeTexPath).with({ scheme: 'vsls' })) as vscode.Uri
        const pdfPath = this.extension.manager.tex2pdf(texPath.fsPath)
        this.extension.manager.watchPdfFile(pdfPath)
        const fileArgs = await this.getPdfArgs(pdfPath)
        return fileArgs
    }

    async sendPdfUpdateToGuests(pdfPath: string) {
        if (this.hostService) {
            const fileArgs = await this.getPdfArgs(pdfPath)
            this.hostService.notify(pdfUpdateNotificationName, fileArgs)
        }
    }

    /********************************************************************
     *
     * Guest
     *
     * *****************************************************************/

    private async initGuest() {
        if (this.liveshare) {
            this.guestService = await this.liveshare.getSharedService(serviceName)
            if (this.guestService) {
                this.guestService.onNotify(pdfUpdateNotificationName, async (args) => await this.onPdfUpdated(args as PdfArgs))
            }
        }
    }

    private getPathWithOutDir(relativePath: string) {
        const outDir = this.getOutDir(relativePath)
        return path.join(outDir, relativePath)
    }

    private async writePdf(pdfArgs: PdfArgs) {
        const buffer = new Buffer(pdfArgs.content, 'binary')
        const pdfPath = this.getPathWithOutDir(pdfArgs.relativePath)
        try {
            await fs.promises.mkdir(path.dirname(pdfPath))
        } catch { /* directory already exists */ }
        await fs.promises.writeFile(pdfPath, buffer)
    }

    private async onPdfUpdated(fileArgs: PdfArgs) {
        await this.writePdf(fileArgs)
    }

    async requestPdf(texPath: string) {
        if (this.guestService) {
            const results = await this.guestService.request(requestPdfRequestName, [texPath])
            await this.writePdf(results)
        }
    }

}
