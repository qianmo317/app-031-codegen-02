import { reactive } from 'vue'

export type PrintSection = 'nest' | 'cut' | 'order' | 'labels'

interface PrintState {
  jobId: string | null
  sections: PrintSection[]
  documentId: string | null
  revNo: number
}

export const printState = reactive<PrintState>({
  jobId: null,
  sections: ['nest', 'cut', 'order', 'labels'],
  documentId: null,
  revNo: 0
})

export function printJob(jobId: string, sections: PrintSection[], documentId?: string, revNo = 0): void {
  printState.jobId = jobId
  printState.sections = sections
  printState.documentId = documentId ?? null
  printState.revNo = revNo
  // 等打印文档渲染完再唤起打印
  setTimeout(() => window.print(), 60)
}
