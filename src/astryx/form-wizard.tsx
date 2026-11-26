// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from Astryx 0.7.17's official `form-wizard` page template.
// Retains its Layout / LayoutHeader / LayoutContent frame, padding=5 and
// VStack gap=5, with an on-track Stepper above one active business panel.
import {useEffect, useLayoutEffect, useRef, useState, memo} from 'react';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Avatar} from '@astryxdesign/core/Avatar';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {Layout, LayoutHeader, LayoutContent} from '@astryxdesign/core/Layout';
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {HStack, VStack, StackItem} from '@astryxdesign/core/Stack';
import {Step, Stepper} from '@astryxdesign/core/Stepper';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TopNav} from '@astryxdesign/core/TopNav';

const STEPS = [
  {key:'upload',label:'上传发票'},
  {key:'interview',label:'补充信息'},
  {key:'draft',label:'发票清单'},
  {key:'submit',label:'提交前预览'},
];

// This boundary keeps the existing DOM nodes, native listeners and form state.
// React owns the surrounding shell; the tested reimbursement controller owns
// the panel internals. Reparenting never serializes a draft or its attachments.
export const ExistingRegion = memo(function ExistingRegion({node, className=''}) {
  const ref=useRef(null);
  useLayoutEffect(()=>{if(node) ref.current.appendChild(node);},[node]);
  return <VStack ref={ref} className={`existing-region ${className}`} gap={0} />;
});

const act=(id)=>document.getElementById(id)?.click();

export default function ExpenseWizard({workspace,auth,saveStatus,portals}) {
  const [step,setStep]=useState(0);
  const [navOpen,setNavOpen]=useState(false);
  const runAction=(id)=>{setNavOpen(false);setTimeout(()=>act(id),0);};
  useEffect(()=>{
    const update=(event)=>setStep(Math.max(0,STEPS.findIndex(s=>s.key===event.detail.stage)));
    window.addEventListener('expense:stage',update);
    return ()=>window.removeEventListener('expense:stage',update);
  },[]);
  const sideNav=(
    <SideNav
      header={<SideNavHeading heading="报了呗" superheading="ANEVER" subheading="采购与报销工作台" icon={<Avatar src="./assets/logo-zbs.webp" name="报了呗" shape="rounded" size="md" tooltip={false} />} />}
      topContent={<Button label="新建报销" variant="primary" width="100%" onClick={()=>runAction('btn-reset')} icon={<Icon icon="upload" />} />}
      footer={<VStack gap={2}><Text type="supporting" color="secondary">发票放进去了，唠唠就完事了。</Text><Text type="supporting" color="secondary">ANEVER · 让每一笔有着落</Text></VStack>}>
      <SideNavSection title="工作台">
        <SideNavItem label="当前报销" icon="viewColumns" isSelected onClick={()=>document.getElementById('main-content')?.focus()} />
        <SideNavItem label="我的报销" icon="clock" onClick={()=>runAction('btn-records')} />
        <SideNavItem label="保存草稿" icon="copy" onClick={()=>runAction('btn-save-draft')} />
      </SideNavSection>
      <SideNavSection title="工具与帮助">
        <SideNavItem label="AI 设置" icon="wrench" onClick={()=>runAction('btn-ai-settings')} />
        <SideNavItem label="工作手册" icon="info" href="./handbook.html" />
        <SideNavItem label="经典填空" icon="externalLink" href="./classic/index.html" />
      </SideNavSection>
    </SideNav>
  );
  return <>
    <AppShell variant="section" height="auto" contentPadding={0} sideNav={sideNav} mobileNav={{isOpen:navOpen,onOpenChange:setNavOpen}}
      topNav={<TopNav label="工作台导航"
        heading={<HStack gap={2} vAlign="center"><Text color="secondary">采购工作台</Text><Icon icon="chevronRight" color="secondary" size="sm" /><Text weight="medium">新建报销</Text></HStack>}
        endContent={<HStack gap={3} vAlign="center"><ExistingRegion node={saveStatus} className="save-region" /><ExistingRegion node={auth} /></HStack>}
      />}>
      <Layout height="auto" contentWidth="100%" padding={5} defaultHasDividers
        header={<LayoutHeader hasDivider={false}>
          <VStack gap={5}>
            <HStack gap={3} vAlign="center" wrap="wrap">
              <StackItem size="fill"><VStack gap={2}>
                <Text type="supporting" color="secondary">REIMBURSEMENT / 报销申请</Text>
                <Heading level={1}>把发票交给我们，<br className="mobile-title-break" />把时间留给正事。</Heading>
                <Text color="secondary">从上传到预览，四步整理好这一单。</Text>
              </VStack></StackItem>
              <Button label="我的报销" icon={<Icon icon="clock" />} onClick={()=>runAction('btn-records')} />
            </HStack>
            <Stepper activeStep={step} label="报销流程进度" density="balanced" indicatorPosition="on-track" horizontalOptions={{minimumStepWidth:112,collapsedVariant:'withLabel'}}>
              {STEPS.map((s,i)=><Step key={s.key} step={i} label={s.label} />)}
            </Stepper>
          </VStack>
        </LayoutHeader>}
        content={<LayoutContent isScrollable={false} label="报销填写区"><ExistingRegion node={workspace} className="workspace-region" /></LayoutContent>}
      />
    </AppShell>
    {portals}
  </>;
}
