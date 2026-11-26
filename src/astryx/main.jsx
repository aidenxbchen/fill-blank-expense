import {createRoot} from 'react-dom/client';
import {createPortal,flushSync} from 'react-dom';
import {Theme} from '@astryxdesign/core/theme';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {VStack} from '@astryxdesign/core/Stack';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import zhCN from '@astryxdesign/core/locales/zh-CN.generated.js';
import './legacy.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import {themes,defaultThemeSlug} from '../../astryx-themes.js';
import ExpenseWizard from './form-wizard';
import './workspace.css';

const workspace=document.getElementById('main-content');
const auth=document.getElementById('auth-box');
const saveStatus=document.querySelector('.save-strip');
const oldHeader=document.querySelector('.app-header');
const portals=[];
// Upgrade existing static actions to real Astryx Buttons while preserving IDs,
// form association and native events consumed by app.js. Native disabled
// remains controller-owned; do not freeze it in an isDisabled prop. Dynamic invoice rows
// remain owned by the existing controller so edits and uploads stay intact.
for(const button of document.querySelectorAll('button.btn')) {
  const host=document.createElement('span');
  host.className='astryx-action-slot';
  const attrs=Object.fromEntries([...button.attributes].filter(a=>a.name.startsWith('aria-')||a.name.startsWith('data-')).map(a=>[a.name,a.value]));
  const variant=button.classList.contains('btn-primary')?'primary':button.classList.contains('btn-danger')?'destructive':button.classList.contains('btn-ghost')?'ghost':'secondary';
  const label=button.textContent.trim();
  const id=button.id;
  button.replaceWith(host);
  portals.push(createPortal(<Button {...attrs} id={id||undefined} type={button.type} name={button.name||undefined} form={button.getAttribute('form')||undefined}
    label={label} variant={variant} size={button.classList.contains('btn-sm')?'sm':'md'} ref={node=>{if(node) node.disabled=button.disabled;}} hidden={button.hidden}
    className={button.className.replace(/\bbtn(?:-[\w-]+)?\b/g,'').trim()||undefined} />,host,id||undefined));
}
// The old toolbar is a stable command target for both desktop and mobile nav.
// Keep its original IDs exactly once; the shell's nav dispatches their clicks.
oldHeader.hidden=true;
oldHeader.setAttribute('aria-hidden','true');
const oldRail=workspace.querySelector('.stage-rail');
oldRail.hidden=true;
// AppShell supplies the main landmark; the business region keeps its focus ID.
const region=document.createElement('section');
for(const attr of workspace.attributes)region.setAttribute(attr.name,attr.value);
region.classList.add('astryx-workspace');
while(workspace.firstChild)region.appendChild(workspace.firstChild);
workspace.replaceWith(region);
const uploadTitle=region.querySelector('.hero-title');
uploadTitle.textContent='先把发票放进来';
region.querySelector('.hero-sub').textContent='批量上传 PDF 或图片，识别后一起核对。整单信息只需补充一次。';
region.querySelector('.dropzone strong').textContent='拖拽发票到这里';
const uploadHost=document.createElement('span');
uploadHost.className='upload-button-slot';
region.querySelector('.dropzone-inner').appendChild(uploadHost);
portals.push(createPortal(<Button label="选择发票文件" variant="primary" icon={<Icon icon="upload" />} onClick={e=>{e.stopPropagation();document.getElementById('file-input').click();}} />,uploadHost));
const empty=region.querySelector('#upload-detail-placeholder');
empty.textContent='还没有发票。上传后，识别结果会在这里按行整理。';
const iconHost=document.createElement('span');
region.querySelector('.dropzone-icon').replaceWith(iconHost);
portals.push(createPortal(<VStack className="upload-symbol" padding={3}><Icon icon="upload" size="lg" /></VStack>,iconHost));
const root=document.createElement('div');
root.id='astryx-root';
oldHeader.after(root);
flushSync(()=>createRoot(root).render(<InternationalizationProvider locale="zh-CN" messages={{"zh-CN":zhCN}} overrides={{"zh-CN":{"@astryx.mobileNav.toggle.open":"打开导航","@astryx.mobileNav.navigation":"导航"}}}><Theme theme={themes[defaultThemeSlug]} mode="light"><ExpenseWizard workspace={region} auth={auth} saveStatus={saveStatus} portals={portals} /></Theme></InternationalizationProvider>));
document.body.dataset.ui='astryx';
