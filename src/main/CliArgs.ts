import path from 'path'

export interface CliArgs {
  storyFile: string
  outputDir: string
  outputFile: string
  width: number
  height: number
  fps: number
  quality: number
  exit: boolean
  headless: boolean
}

export function parseCliArgs(argv: string[]): CliArgs | null {
  // 跳过前两个元素：node 路径和 electron 路径
  const args = argv.slice(2)

  // 如果没有参数，返回 null 表示 GUI 模式
  if (args.length === 0) {
    return null
  }

  const cliArgs: Partial<CliArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--story-file':
      case '-s':
        cliArgs.storyFile = args[++i]
        break
      case '--output-dir':
      case '-d':
        cliArgs.outputDir = args[++i]
        break
      case '--output-file':
      case '-o':
        cliArgs.outputFile = args[++i]
        break
      case '--width':
      case '-W':
        cliArgs.width = parseInt(args[++i], 10)
        break
      case '--height':
      case '-H':
        cliArgs.height = parseInt(args[++i], 10)
        break
      case '--fps':
      case '-f':
        cliArgs.fps = parseInt(args[++i], 10)
        break
      case '--quality':
      case '-q':
        cliArgs.quality = parseFloat(args[++i])
        break
      case '--exit':
        cliArgs.exit = true
        break
      case '--headless':
        cliArgs.headless = true
        break
      case '--help':
      case '-h':
        printCliHelp()
        process.exit(0)
        break
      default:
        // 如果遇到未知参数，打印帮助并退出
        console.error(`未知参数: ${arg}`)
        printCliHelp()
        process.exit(1)
    }
  }

  // 如果没有提供必需的参数，返回 null 表示 GUI 模式
  if (!cliArgs.storyFile && !cliArgs.outputFile) {
    return null
  }

  // 验证必需参数
  if (!cliArgs.storyFile) {
    console.error('错误: 缺少必需参数 --story-file 或 -s')
    printCliHelp()
    process.exit(1)
  }

  if (!cliArgs.outputFile) {
    console.error('错误: 缺少必需参数 --output-file 或 -o')
    printCliHelp()
    process.exit(1)
  }

  // 验证数值参数
  if (cliArgs.width !== undefined && (isNaN(cliArgs.width) || cliArgs.width <= 0)) {
    console.error('错误: --width 必须是正整数')
    process.exit(1)
  }

  if (cliArgs.height !== undefined && (isNaN(cliArgs.height) || cliArgs.height <= 0)) {
    console.error('错误: --height 必须是正整数')
    process.exit(1)
  }

  if (cliArgs.fps !== undefined && (isNaN(cliArgs.fps) || cliArgs.fps <= 0)) {
    console.error('错误: --fps 必须是正整数')
    process.exit(1)
  }

  if (cliArgs.quality !== undefined && (isNaN(cliArgs.quality) || cliArgs.quality <= 0)) {
    console.error('错误: --quality 必须是正数')
    process.exit(1)
  }

  // 返回完整的 CliArgs，设置默认值
  return {
    storyFile: cliArgs.storyFile,
    outputDir: cliArgs.outputDir || path.dirname(cliArgs.outputFile),
    outputFile: cliArgs.outputFile,
    width: cliArgs.width || 1280,
    height: cliArgs.height || 720,
    fps: cliArgs.fps || 60,
    quality: cliArgs.quality || 1.0,
    exit: cliArgs.exit || false,
    headless: cliArgs.headless || false
  }
}

export function printCliHelp(): void {
  console.log(`
用法: MySekaiStoryteller [选项]

必需参数:
  -s, --story-file <path>      故事文件路径 (*.sekai-story.json)
  -o, --output-file <path>     输出视频文件路径 (*.mp4)

可选参数:
  -d, --output-dir <path>      帧图片输出目录 (默认: 视频文件所在目录)
  -W, --width <number>         视频宽度 (默认: 1280)
  -H, --height <number>        视频高度 (默认: 720)
  -f, --fps <number>           帧率 (默认: 60)
  -q, --quality <number>       渲染质量/缩放 (默认: 1.0, 可选: 0.85/0.9/0.95/1.0/1.25/1.5/1.75/2.0)
      --exit                   渲染完成后自动退出程序
      --headless               无头模式，不显示窗口（纯后台渲染）
  -h, --help                   显示帮助信息

示例:
  MySekaiStoryteller -s ./story/test.sekai-story.json -o ./output/video.mp4
  MySekaiStoryteller -s ./story/test.sekai-story.json -o ./output/video.mp4 -W 1920 -H 1080 -q 1.5 --exit
  MySekaiStoryteller -s ./story/test.sekai-story.json -o ./output/video.mp4 -d ./frames --headless --exit
`)
}
