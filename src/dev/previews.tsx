import { ComponentPreview, Previews } from '@react-buddy/ide-toolbox'
import { PaletteTree } from './palette'
import App from '@windows/welcome/App'
import LeftSidebar from '@windows/welcome/components/LeftSidebar'

const ComponentPreviews = () => {
  return (
    <Previews palette={<PaletteTree />}>
      <ComponentPreview path="/App">
        <App />
      </ComponentPreview>
      <ComponentPreview path="/LeftSidebar">
        <LeftSidebar />
      </ComponentPreview>
    </Previews>
  )
}

export default ComponentPreviews
